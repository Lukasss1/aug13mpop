// Runs ONE real Edge Function on FN_PORT instead of Deno's fixed 8000, so
// three can share the box. Nothing else is patched.
const orig = Deno.serve;
Object.defineProperty(Deno, 'serve', {
  value: (handler: unknown) =>
    (orig as (o: unknown, h: unknown) => unknown)({ port: Number(Deno.env.get('FN_PORT')) }, handler),
});
await import(Deno.env.get('FN_ENTRY')!);
