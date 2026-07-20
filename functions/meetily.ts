export default function (): Response {
  return new Response(JSON.stringify({ error: "This legacy Meetily endpoint has been retired." }), {
    status: 410,
    headers: { "content-type": "application/json" },
  });
}
