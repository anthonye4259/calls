import { bindings } from "../../../lib/hosted-calls";
import { createDistributor, listDistributors } from "../../../lib/relay-data";

export async function GET() {
  const runtime = await bindings();
  return Response.json({ distributors: await listDistributors(runtime.DB) });
}

export async function POST(request: Request) {
  try {
    const runtime = await bindings();
    const distributor = await createDistributor(runtime.DB, await request.json());
    return Response.json({ distributor }, { status: 201 });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not save distributor" },
      { status: 400 },
    );
  }
}
