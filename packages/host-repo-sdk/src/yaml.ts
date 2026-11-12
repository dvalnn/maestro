import { stringify } from "yaml";

/**
 * A typed value as YAML, the one rendering a seat reads of a value.
 * @param value the value to render.
 * @returns the YAML text.
 */
export const yamlOf = (value: unknown): string => stringify(value);
