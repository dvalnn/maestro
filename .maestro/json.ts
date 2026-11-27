export type Json = Record<string, unknown>;

export const isJson = (v: unknown): v is Json =>
	typeof v === "object" && v !== null && !Array.isArray(v);
