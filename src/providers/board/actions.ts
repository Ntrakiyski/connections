import type { ActionDefinition } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";

const service = "board";

const rawObject = s.unknownObject("A raw object returned by the Board API.");
const roomId = s.nonEmptyString("The Board room ID, usually the value after /board/ in the Board URL.");
const records = s.array("Raw tldraw records.", rawObject, { minItems: 1 });
const recordIds = s.array("Raw tldraw record IDs.", s.nonEmptyString("A tldraw record ID."), { minItems: 1 });

export const boardActions: ActionDefinition[] = [
  defineProviderAction(service, {
    name: "list_boards",
    description: "List boards visible to the connected Board workspace token.",
    inputSchema: s.object("Input for listing Board boards.", {}, { optional: [] }),
    outputSchema: s.actionOutput(
      { boards: s.array("Boards visible to the connected workspace token.", rawObject) },
      "Board list response.",
    ),
    riskTags: ["read"],
    idempotency: "not_supported",
    followUpActions: ["board.read_board"],
  }),
  defineProviderAction(service, {
    name: "read_board",
    description: "Read raw tldraw records, shapes, assets, and bindings for one Board board.",
    inputSchema: s.actionInput({ roomId }, ["roomId"], "Input for reading one Board board."),
    outputSchema: s.actionOutput(
      {
        roomId,
        records: s.array("All raw tldraw records on the board.", rawObject),
        shapes: s.array("Raw tldraw shape records on the board.", rawObject),
        assets: s.array("Raw tldraw asset records on the board.", rawObject),
        bindings: s.array("Raw tldraw binding records on the board.", rawObject),
      },
      "Board records response.",
    ),
    riskTags: ["read"],
    idempotency: "not_supported",
    followUpActions: ["board.create_or_update_records", "board.delete_records"],
  }),
  defineProviderAction(service, {
    name: "get_board_snapshot",
    description: "Read the full tldraw sync snapshot for one Board board.",
    inputSchema: s.actionInput({ roomId }, ["roomId"], "Input for reading one Board snapshot."),
    outputSchema: s.actionOutput({ snapshot: rawObject }, "Board snapshot response."),
    riskTags: ["read"],
    idempotency: "not_supported",
  }),
  defineProviderAction(service, {
    name: "rename_board",
    description: "Change a board's display name.",
    inputSchema: s.actionInput(
      {
        roomId,
        name: s.string("The new board name.", { minLength: 1, maxLength: 120 }),
      },
      ["roomId", "name"],
      "Input for renaming one Board board.",
    ),
    outputSchema: rawObject,
    riskTags: ["write"],
    idempotency: "optional",
    followUpActions: ["board.list_boards"],
  }),
  defineProviderAction(service, {
    name: "create_or_update_records",
    description: "Create or update raw tldraw records on one Board board.",
    inputSchema: s.actionInput({ roomId, records }, ["roomId", "records"], "Input for writing Board records."),
    outputSchema: s.actionOutput(
      {
        roomId,
        count: s.integer("Number of records written."),
        records: s.array("Records written to the board.", rawObject),
      },
      "Board write response.",
    ),
    riskTags: ["write"],
    idempotency: "optional",
    followUpActions: ["board.read_board"],
  }),
  defineProviderAction(service, {
    name: "delete_records",
    description: "Delete raw tldraw records from one Board board by record ID.",
    inputSchema: s.actionInput({ roomId, recordIds }, ["roomId", "recordIds"], "Input for deleting Board records."),
    outputSchema: s.actionOutput(
      {
        roomId,
        count: s.integer("Number of records deleted."),
        recordIds,
      },
      "Board delete response.",
    ),
    riskTags: ["delete"],
    idempotency: "optional",
    followUpActions: ["board.read_board"],
  }),
];
