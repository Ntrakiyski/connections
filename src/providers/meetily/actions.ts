import type { ActionDefinition } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";

const service = "meetily";
const meetingSchema = s.looseObject("A completed Meetily meeting.", {
  externalId: s.nonEmptyString("Stable Meetily meeting ID."),
  title: s.nonEmptyString("Meeting title."),
  transcript: s.string("Full transcript text when requested."),
  summary: s.nullable(s.string("Meeting summary when available.")),
  actionItems: s.array("Meeting action items.", s.unknown("Action item.")),
  createdAt: s.nonEmptyString("Time the meeting was first stored."),
  updatedAt: s.nonEmptyString("Time the stored meeting was last updated."),
});

export type MeetilyActionName = "list_meetings" | "get_meeting" | "get_latest_meeting" | "search_transcripts";

export const meetilyActions: ActionDefinition[] = [
  defineProviderAction(service, {
    name: "list_meetings",
    description: "List recently completed Meetily meetings.",
    inputSchema: s.object(
      { limit: s.integer("Maximum meetings to return.", { minimum: 1, maximum: 100 }) },
      { optional: ["limit"], description: "Meeting list options." },
    ),
    outputSchema: s.object(
      { meetings: s.array("Meetily meetings.", meetingSchema) },
      { required: ["meetings"], description: "Completed Meetily meetings." },
    ),
  }),
  defineProviderAction(service, {
    name: "get_meeting",
    description: "Get one completed Meetily meeting and its transcript.",
    inputSchema: s.object(
      { externalId: s.nonEmptyString("Meetily meeting ID.") },
      { required: ["externalId"], description: "Meeting lookup." },
    ),
    outputSchema: s.object(
      { meeting: s.nullable(meetingSchema) },
      { required: ["meeting"], description: "The matching meeting, or null." },
    ),
  }),
  defineProviderAction(service, {
    name: "get_latest_meeting",
    description: "Get the most recently stored Meetily meeting and its transcript.",
    inputSchema: s.object({}, { description: "No input parameters." }),
    outputSchema: s.object(
      { meeting: s.nullable(meetingSchema) },
      { required: ["meeting"], description: "The latest meeting, or null." },
    ),
  }),
  defineProviderAction(service, {
    name: "search_transcripts",
    description: "Search completed Meetily meeting transcripts for text.",
    inputSchema: s.object(
      {
        query: s.nonEmptyString("Text to find in meeting transcripts."),
        limit: s.integer("Maximum matches to return.", { minimum: 1, maximum: 100 }),
      },
      { required: ["query"], optional: ["limit"], description: "Transcript search options." },
    ),
    outputSchema: s.object(
      { meetings: s.array("Meetily meetings with matching transcripts.", meetingSchema) },
      { required: ["meetings"], description: "Matching Meetily meetings." },
    ),
  }),
];
