import { bindings } from "../../../lib/hosted-calls";
import { getRelayProfile, saveRelayProfile } from "../../../lib/relay-data";

export async function GET() {
  const runtime = await bindings();
  return Response.json({ profile: await getRelayProfile(runtime.DB) });
}

export async function PATCH(request: Request) {
  const runtime = await bindings();
  const profile = await saveRelayProfile(runtime.DB, await request.json());
  return Response.json({ profile });
}
