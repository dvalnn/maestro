import { CORE_TYPES, MAESTRO_TYPE } from "@maestro/ir";
import type { Type } from "@maestro/sdk";

/** A repo host lane version, `<concert id>.<node instance id>`. */
export const Lane: Type<string> = {
	schema: { type: "string", [MAESTRO_TYPE]: "repo.lane" },
};

/** The file a check writes its logs to. */
export const Logs: Type<unknown> = {
	schema: { [MAESTRO_TYPE]: CORE_TYPES.file },
};
