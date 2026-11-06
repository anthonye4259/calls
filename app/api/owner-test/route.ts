import { bindings } from "../../../lib/hosted-calls";
import { prepareOwnerTestCall, PrepareCallError } from "../../../lib/prepare-call";

export async function POST(request: Request) {
  try {
    const result = await prepareOwnerTestCall(await bindings(), request.url);
    return Response.json(result, { status: 201 });
  } catch (cause) {
    const status = cause instanceof PrepareCallError ? cause.status : 500;
    return Response.json({ error: cause instanceof Error ? cause.message : "Owner test failed" }, { status });
  }
}
