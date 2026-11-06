import { bindings, getCall, saveCall } from "../../../../../lib/hosted-calls";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const runtime = await bindings();
  const { id } = await context.params;
  const call = await getCall(runtime.DB, id);
  if (!call) return Response.json({ error: "Call not found" }, { status: 404 });
  const input = (await request.json()) as Record<string, unknown>;
  call.outcome = {
    ...input,
    capturedBy: "human",
    capturedAt: new Date().toISOString(),
  };
  call.updatedAt = new Date().toISOString();
  await saveCall(runtime.DB, call);
  return Response.json({ call });
}
