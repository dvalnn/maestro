// A bare composition file that holds at two approvals side by side: one at the top, one in a fan-out with inputs.
import { approval, Bool, code, composition, File, iter } from "@maestro/sdk";

/** Writes the release notes the `publish` approval rules on. */
export async function notes(_: object, ctx: { scratch: string }) {
	const path = `${ctx.scratch}/notes.md`;
	await Bun.write(path, "# Notes\n");
	return { notes: path };
}

export const approve = composition(
	"approve",
	{
		// Off by default: the file's directory in the artifact area differs between runs.
		params: { notes: Bool({ default: false }) },
		examples: [{}],
	},
	({ notes: withNotes }) => {
		approval("Apply the migration\u001b[31m to staging?\r", { label: "go" });
		const written = withNotes
			? code(notes, { out: { notes: File() } }).out
			: {};
		return iter.parMap(
			["eu"],
			(region) =>
				approval("Publish v9.9.9 to the forge?", {
					label: "publish",
					in: {
						region,
						version: "9.9.9",
						summary: "no finding blocks\nthe release",
						...written,
					},
				}),
			{ label: "fan", onError: "stop" },
		);
	},
);
