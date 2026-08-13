// Minimal ambient declarations for the tiny Deno surface these Edge Functions
// use. The authoritative typecheck for functions is `deno check` in a Deno
// environment; this shim keeps editors and a lightweight `tsc` pass from
// erroring on the `Deno` global without pulling Deno's std types over the
// network. Extend only as functions genuinely need more of the Deno API.
declare namespace Deno {
  function serve(handler: (req: Request) => Response | Promise<Response>): void;
  const env: { get(key: string): string | undefined };
}
