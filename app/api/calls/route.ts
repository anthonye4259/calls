import { bindings, listCalls } from "../../../lib/hosted-calls";
import { getDistributor } from "../../../lib/relay-data";
import { prepareCall, PrepareCallError } from "../../../lib/prepare-call";

export async function GET() {
  const runtime = await bindings();
  return Response.json({ calls: await listCalls(runtime.DB) });
}

export async function POST(request: Request) {
  const runtime = await bindings();
  const body = (await request.json()) as Record<string, unknown>;
  const distributorId = String(body.distributorId ?? "").trim();
  const distributor = distributorId
    ? await getDistributor(runtime.DB, distributorId)
    : null;
  if (distributorId && !distributor) {
    return Response.json({ error: "Distributor not found" }, { status: 404 });
  }
  if (distributor && distributor.status !== "ready") {
    return Response.json(
      { error: "Distributor needs documented permission before calling" },
      { status: 403 },
    );
  }
  if (body.authorized !== true) {
    return Response.json(
      { error: "Confirm that the recipient authorized this call" },
      { status: 400 },
    );
  }
  if (!distributor) return Response.json({ error: "A Relay distributor is required" }, { status: 400 });
  try {
    const result = await prepareCall(runtime, request.url, distributor);
    return Response.json(result, { status: 201 });
  } catch (cause) {
    const status = cause instanceof PrepareCallError ? cause.status : 500;
    return Response.json({ error: cause instanceof Error ? cause.message : "Call preparation failed" }, { status });
  }
}
