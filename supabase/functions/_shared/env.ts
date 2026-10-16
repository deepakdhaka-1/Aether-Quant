// Configuration comes only from the function environment (`supabase secrets set`), never from files.
export const env = (name: string, def = ""): string => Deno.env.get(name) ?? def;
export const envNum = (name: string, def: number): number => {
  const v = Deno.env.get(name);
  const n = v === undefined || v === "" ? NaN : Number(v);
  return Number.isFinite(n) ? n : def;
};
export const envBool = (name: string, def: boolean): boolean => {
  const v = Deno.env.get(name);
  if (v === undefined) return def;
  return ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
};
