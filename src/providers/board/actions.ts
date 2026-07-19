import type { ActionDefinition } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";

const service = "board";
const roomIdSchema = s.nonEmptyString("The board room ID from the board URL or list_boards response.");
const recordSchema = s.looseRequiredObject("A raw tldraw record.", {
  id: s.nonEmptyString("The stable tldraw record ID, such as shape:abc123."),
  typeName: s.nonEmptyString("The tldraw record type name, such as shape, asset, or binding."),
});
const boardSchema = s.requiredObject("Board metadata.", {
  id: s.nonEmptyString("The board room ID."),
  workspaceId: s.nonEmptyString("The Board workspace that owns the board."),
  name: s.string("The board's optional display name."),
  createdAt: s.dateTime("When the board was created."),
  updatedAt: s.dateTime("When the board metadata was last updated."),
  url: s.string("The relative URL used to open the board in the web editor."),
});
const recordsOutputProperties = {
  roomId: roomIdSchema,
  workspaceId: s.nonEmptyString("The Board workspace that owns the board."),
  documentClock: s.nonNegativeInteger("The current tldraw document clock."),
  records: s.array("All raw tldraw records in the board.", recordSchema),
  shapes: s.array("Shape records in the board.", recordSchema),
  assets: s.array("Asset records in the board.", recordSchema),
  bindings: s.array("Binding records in the board.", recordSchema),
};

export type BoardActionName =
  | "list_boards"
  | "read_board"
  | "rename_board"
  | "create_or_update_records"
  | "delete_records";

export const boardActions: ActionDefinition[] = [
  defineProviderAction(service, {
    name: "list_boards",
    description: "List known boards with their names, URLs, and timestamps, newest first.",
    riskTags: ["read"],
    inputSchema: s.object({}, { description: "No input parameters." }),
    outputSchema: s.requiredObject("Known Board rooms.", {
      boards: s.array("Boards available to the connected workspace.", boardSchema),
    }),
    followUpActions: ["board.read_board"],
  }),
  defineProviderAction(service, {
    name: "read_board",
    description: "Read all raw tldraw records for a board, grouped into shapes, assets, and bindings.",
    riskTags: ["read"],
    inputSchema: s.requiredObject("Board lookup.", { roomId: roomIdSchema }),
    outputSchema: s.requiredObject("The current board records.", recordsOutputProperties),
    followUpActions: ["board.create_or_update_records", "board.delete_records"],
  }),
  defineProviderAction(service, {
    name: "rename_board",
    description: "Change a board's display name.",
    riskTags: ["write"],
    inputSchema: s.requiredObject("Board rename request.", {
      roomId: roomIdSchema,
      name: s.string("The new board name.", { minLength: 1, maxLength: 120 }),
    }),
    outputSchema: boardSchema,
    followUpActions: ["board.list_boards"],
  }),
  defineProviderAction(service, {
    name: "create_or_update_records",
    description:
      "Create raw tldraw records or replace existing records with matching IDs. Records must contain the fields required by their tldraw record type.",
    riskTags: ["write"],
    inputSchema: s.requiredObject("Raw tldraw records to write.", {
      roomId: roomIdSchema,
      records: s.array("Records to create or replace.", recordSchema),
    }),
    outputSchema: s.requiredObject("The records written to the board.", {
      roomId: roomIdSchema,
      count: s.nonNegativeInteger("The number of records written."),
      records: s.array("The records accepted by Board.", recordSchema),
    }),
    followUpActions: ["board.read_board"],
  }),
  defineProviderAction(service, {
    name: "delete_records",
    description: "Delete raw tldraw records from a board by record ID.",
    riskTags: ["delete"],
    inputSchema: s.requiredObject("Raw tldraw records to delete.", {
      roomId: roomIdSchema,
      recordIds: s.stringArray("Record IDs to delete, such as shape:abc123."),
    }),
    outputSchema: s.requiredObject("The records deleted from the board.", {
      roomId: roomIdSchema,
      count: s.nonNegativeInteger("The number of record IDs processed."),
      recordIds: s.stringArray("The record IDs processed by Board."),
    }),
    followUpActions: ["board.read_board"],
  }),
];
