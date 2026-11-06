import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closest } from "@maestro/core";
import { ConfigError } from "@maestro/core/config";
import { type HostSetup, hostSetup } from "@maestro/core/host";
import {
	findProfile,
	HOST_NAME,
	heldNames,
	type Inspection,
	inspectProfile,
	isSettled,
	keepWindow,
	type ProbeReport,
	type Profile,
	type ProfileRoot,
	probe,
	probeRequest,
	probeSections,
	profileRoot,
	profileSections,
	resolveUnsettled,
	SandboxUnavailable,
	type SeatedAgent,
	type SectionsView,
	seatedAgents,
	sourceWords,
	type Unsettled,
	unsetOf,
	windowOf,
} from "@maestro/host-repo";
import {
	type AgentEnvironment,
	type EnvironmentCheck,
	environmentChecks,
	faultCount,
} from "@maestro/host-repo/harness";
import { messageOf } from "@maestro/ir";
import {
	COMMON,
	type Command,
	colorOf,
	type Deps,
	isSet,
	type Options,
	only,
	parse,
	splitFirst,
	type Values,
} from "./command";
import { builtinHarnesses } from "./hosts";
import { CliError, EXIT, jsonOf, paint, table, usageError } from "./output";
import { prepare } from "./prepare";
import { sectionsText } from "./sections";
import { openSession, overridesOf, type Session, setupOf } from "./session";

const AGENT_OPTIONS: Options = COMMON;

const FIX =
	"Run 'maestro agent ls', 'maestro agent show <profile>', or 'maestro agent probe <profile>'";
const NAME_PROFILE = "Name one as 'maestro agent ls' lists it";
const NAME_AGENT_NODE =
	"Name an agent node, as 'maestro compose <composition>' lists them";
const NAME_COMPOSITION = "Name it by file path or <pack>.<composition>";

const INDENT = "  ";

type Request =
	| { action: "ls" }
	| { action: "show"; name: string }
	| { action: "probe"; name: string }
	| { action: "prompt"; target: string; node: string };

type Listed = {
	name: string;
	root: ProfileRoot;
	dir: string;
	shadowsPack: boolean;
	harness?: string;
	model?: string;
	/** The messages of the diagnostics that kept the profile from resolving, with their `profile <name>: ` lead. */
	faults: string[];
};

type Setup = Pick<HostSetup, "layers" | "roots">;

function lsRequest(rest: readonly string[]): Request {
	if (rest.length > 0)
		throw usageError(
			`agent ls takes no profile, got ${rest.length}`,
			"Run 'maestro agent show <profile>' for one profile",
		);
	return { action: "ls" };
}

function showRequest(rest: readonly string[]): Request {
	return {
		action: "show",
		name: only(rest, "profile", NAME_PROFILE, "show"),
	};
}

function probeRequestOf(rest: readonly string[]): Request {
	return {
		action: "probe",
		name: only(rest, "profile", NAME_PROFILE, "probe"),
	};
}

function promptRequest(rest: readonly string[]): Request {
	const [target, node, ...more] = rest;
	if (target === undefined)
		throw usageError(
			"maestro agent prompt needs a composition",
			NAME_COMPOSITION,
		);
	if (node === undefined)
		throw usageError("maestro agent prompt needs a node", NAME_AGENT_NODE);
	if (more.length)
		throw usageError(
			`agent prompt takes a composition and a node, got ${rest.length} arguments`,
			NAME_AGENT_NODE,
		);
	return { action: "prompt", target, node };
}

/** The request `positionals` makes. @throws CliError, a usage error, for anything else. */
function requestOf(positionals: readonly string[]): Request {
	const [action, ...rest] = positionals;
	if (action === "ls") return lsRequest(rest);
	if (action === "show") return showRequest(rest);
	if (action === "probe") return probeRequestOf(rest);
	if (action === "prompt") return promptRequest(rest);
	throw usageError(
		`expected ls, show, probe or prompt, got ${action === undefined ? "nothing" : `'${action}'`}`,
		FIX,
	);
}

/** `s` as the sections of `agent show`, rendered in color or not. */
async function showText(
	s: Inspection,
	view: SectionsView,
	report: ProbeReport | undefined,
	color: boolean,
): Promise<string> {
	return sectionsText(
		report ? probeSections(s, view, report) : await profileSections(s, view),
		color,
	);
}

const FAULT_SEPARATOR = "; ";

/** The row of profile `name`, which the roots of `setup` hold. */
async function listedOf(name: string, setup: Setup): Promise<Listed[]> {
	const found = await findProfile(name, setup.roots);
	if (!found) return [];
	const { roots } = setup;
	const base = {
		name,
		root: profileRoot(found.dir, roots),
		dir: found.dir,
		shadowsPack: found.shadows.some((d) => profileRoot(d, roots) === "pack"),
	};
	try {
		const { harness, model } = (await resolveUnsettled(name, setup)).fields
			.runtime;
		return [{ ...base, harness, model, faults: [] }];
	} catch (error) {
		if (!(error instanceof ConfigError)) throw error;
		return [{ ...base, faults: error.diagnostics.map((d) => d.message) }];
	}
}

/** `fault` without the `profile <name>: ` lead the row already shows. */
const shownFault = (name: string, fault: string) => {
	const lead = `profile ${name}: `;
	return fault.startsWith(lead) ? fault.slice(lead.length) : fault;
};

/** The roster as a table: name, harness, model, the winning root and a pack shadow, faults under a broken row. */
function lsText(listed: readonly Listed[], color: boolean): string {
	const header = ["Profiles", "harness", "model", "from"].map((h) =>
		paint("bold", h, color),
	);
	const rows = listed.map((l) => [
		`${INDENT}${l.name}`,
		l.harness ?? "-",
		l.model ?? "-",
		l.root,
		l.shadowsPack ? paint("dim", "[shadows pack]", color) : "",
	]);
	const [top = "", ...lines] = table([header, ...rows]).split("\n");
	return [
		top,
		...lines.flatMap((line, i) => {
			const row = listed[i];
			if (!row?.faults.length) return [line];
			const faults = row.faults.map((f) => shownFault(row.name, f));
			return [
				line,
				`${INDENT}${INDENT}${paint("red", faults.join(FAULT_SEPARATOR), color)}`,
			];
		}),
	].join("\n");
}

/** `row` as `--json` gives it: its faults joined as `error`. */
const listedJson = ({ faults, ...row }: Listed) =>
	faults.length ? { ...row, error: faults.join(FAULT_SEPARATOR) } : row;

async function ls(setup: Setup, deps: Deps, values: Values): Promise<number> {
	const held = await heldNames(setup.roots);
	const listed = (
		await Promise.all(held.map((n) => listedOf(n, setup)))
	).flat();
	if (isSet(values, "json"))
		deps.stdout(jsonOf({ profiles: listed.map(listedJson) }));
	else if (listed.length) {
		deps.stdout(lsText(listed, colorOf(deps, values).out));
	} else
		deps.stderr(
			"no profile in any profile root\nCreate .maestro/profiles/<name>/profile.yaml, or install a pack that ships one",
		);
	return EXIT.ok;
}

/** The repo host's setup, none when the host is not loaded. */
function repoSetupOf(session: Session) {
	const host = session.deps.hosts.find((h) => h.name === HOST_NAME);
	return host && setupOf(session, host);
}

/**
 * What the harness of `profile` reports when started as a concert would start it. The model's window it reports is
 * kept for pre-flight.
 * @throws CliError when the harness is not loaded, or its run fails or times out before it reports.
 */
async function probed(
	profile: Profile,
	session: Session,
): Promise<ProbeReport> {
	const { deps } = session;
	const { runtime } = profile.fields;
	const harnesses = builtinHarnesses(deps.env);
	const harness = harnesses.find((h) => h.name === runtime.harness);
	const setup = repoSetupOf(session);
	if (!harness || !setup)
		throw usageError(
			`harness '${runtime.harness}' is not loaded`,
			`Set 'profiles.${profile.name}.runtime.harness' to one of: ${harnesses.map((h) => h.name).join(", ")}`,
		);
	deps.stderr(`probing ${runtime.harness} for ${profile.name}…`);
	const scratch = await mkdtemp(join(tmpdir(), "maestro-probe-"));
	try {
		const req = probeRequest(profile, setup, scratch);
		const { observed, window } = await probe(harness, req);
		if (window !== undefined) keepWindow(setup.store, runtime, window);
		return observed ? { observed } : {};
	} catch (error) {
		if (error instanceof CliError) throw error;
		if (error instanceof SandboxUnavailable)
			throw new CliError(`probe of ${profile.name} failed: ${error.message}`);
		throw new CliError(
			`probe of ${profile.name} failed: ${messageOf(error)}\nRun the profile once, or check ${runtime.harness}'s login`,
		);
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

/** The checks of `report` against `declared`; none without both. */
const checksOf = (declared: AgentEnvironment | null, report?: ProbeReport) =>
	declared && report ? environmentChecks(declared, report.observed ?? {}) : [];

/** The `environment` of `--json`: the declaration, and with a report what was observed and each part's `checks`. */
const environmentJson = (
	declared: AgentEnvironment | null,
	checks: readonly EnvironmentCheck[],
	report?: ProbeReport,
) =>
	report
		? { declared, observed: report.observed ?? null, checks }
		: { declared };

/** `fields` as words, such as `harness and model`. */
const fieldWords = (fields: readonly string[]) => fields.join(" and ");

/** Where to set `fields` of profile `name`, or pass them. */
const unsetFix = (name: string, fields: readonly string[]) =>
	`Pass --preset, or set profiles.${name}.runtime${fields.length === 1 ? `.${fields[0]}` : ""} in .maestro/config.yaml`;

const SHELL_SAFE = /^[\w@%+=:,./-]+$/;
const quoted = (text: string) =>
	SHELL_SAFE.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`;

/** The `maestro agent probe` command for profile `name`, with the `--preset` and `-c` flags `values` gives. */
function probeCommand(name: string, values: Values): string {
	const { presets, config } = overridesOf(values);
	return [
		"maestro agent probe",
		name,
		...(presets ?? []).map((p) => `--preset ${quoted(p)}`),
		...(config ?? []).map((c) => `-c ${quoted(c)}`),
	].join(" ");
}

/** The agent environment each shipped harness launches with, by harness name. */
const declaredEnvironments = ({ env }: Deps) =>
	new Map(
		builtinHarnesses(env).flatMap(
			({ name, environment }): [string, AgentEnvironment][] =>
				environment ? [[name, environment]] : [],
		),
	);

/** Prints `profile` as `agent show` does, `report` checked when it has one; exits 1 for a fault in it. */
async function show(
	profile: Unsettled,
	report: ProbeReport | undefined,
	session: Session,
	values: Values,
): Promise<number> {
	const { deps, config } = session;
	const s = inspectProfile(profile, config.roots, declaredEnvironments(deps));
	const store = repoSetupOf(session)?.store;
	const { harness, model } = profile.fields.runtime;
	const window =
		store === undefined || harness === undefined || model === undefined
			? undefined
			: windowOf(store, { harness, model });
	const { declared } = s.environment;
	const checks = checksOf(declared, report);
	const { out: color, err: errColor } = colorOf(deps, values);
	if (isSet(values, "json"))
		deps.stdout(
			jsonOf({
				...s,
				window: window ?? null,
				environment: environmentJson(declared, checks, report),
			}),
		);
	else
		deps.stdout(
			await showText(
				s,
				{
					roots: config.roots,
					home: deps.env.HOME,
					...(window !== undefined && { window }),
					probeCommand: probeCommand(profile.name, values),
				},
				report,
				color,
			),
		);
	const unset = unsetOf(profile);
	if (unset.length)
		deps.stderr(
			`${fieldWords(unset)} unset\n${INDENT}${paint("dim", unsetFix(profile.name, unset), errColor)}`,
		);
	return faultCount(checks) ? EXIT.failed : EXIT.ok;
}

/**
 * Probes profile `name` and prints what its harness reported, as `agent show` does.
 * @throws CliError, a usage error, when the profile leaves its harness or model unset.
 */
async function probeProfile(
	name: string,
	setup: Setup,
	session: Session,
	values: Values,
): Promise<number> {
	const profile = await resolveUnsettled(name, setup);
	if (!isSettled(profile))
		throw usageError(
			`profile ${name} leaves ${fieldWords(unsetOf(profile))} unset, so there is nothing to probe`,
			unsetFix(name, unsetOf(profile)),
		);
	return show(profile, await probed(profile, session), session, values);
}

/**
 * The agent of `agents` at node `node` of `target`.
 * @throws CliError, a usage error, when none is, with the nearest agent node it has.
 */
function agentAt(agents: SeatedAgent[], node: string, target: string) {
	const found = agents.find((a) => a.node === node);
	if (found) return found;
	const nodes = agents.map((a) => a.node);
	const near = closest(node, nodes);
	throw usageError(
		`${target} has no agent node '${node}'`,
		near === undefined
			? `Name one of: ${nodes.join(", ") || "none"}`
			: `Did you mean '${near}'?`,
	);
}

/** Prints the system prompt of agent node `request.node`, and on stderr the seat and profile it is bound to. */
async function promptOf(
	request: { target: string; node: string },
	session: Session,
	values: Values,
): Promise<number> {
	const { deps } = session;
	const host = deps.hosts.find((h) => h.name === HOST_NAME);
	if (!host)
		throw new CliError(
			`agent nodes belong to host '${HOST_NAME}', which is not loaded`,
		);
	const reading = { verb: "agent prompt", options: COMMON, examples: true };
	const prepared = await prepare(session, reading, [request.target]);
	const setup = hostSetup(host, prepared.config, session.config.roots);
	const { node, key, binding, prompt } = agentAt(
		seatedAgents(prepared.ir, setup),
		request.node,
		request.target,
	);
	const text = prompt(await resolveUnsettled(binding.profile, setup));
	if (isSet(values, "json")) {
		deps.stdout(jsonOf({ node, seat: { key, ...binding }, prompt: text }));
		return EXIT.ok;
	}
	const words = binding.source && sourceWords(binding.source);
	const color = colorOf(deps, values).err;
	deps.stderr(
		`${paint("bold", node, color)} · seat ${key} · ${binding.profile}${words === undefined ? "" : ` ${paint("dim", `[${words}]`, color)}`}`,
	);
	deps.stdout(text);
	return EXIT.ok;
}

export const agent: Command = {
	pages: (args) => splitFirst(AGENT_OPTIONS, args).first === "show",
	usage:
		"agent ls [flags]  (alias: ag)\n       maestro agent show <profile> [flags]\n       maestro agent probe <profile> [flags]\n       maestro agent prompt <composition> <node> [flags]",
	arguments: [
		["<profile>", "A profile, as 'maestro agent ls' lists it"],
		[
			"<composition>",
			"With prompt, the composition the node sits in: a file, or <pack>.<composition>",
		],
		["<node>", "With prompt, an agent node, as 'maestro compose' lists it"],
	],
	options: AGENT_OPTIONS,
	async execute(args, deps) {
		const { values, positionals } = parse(AGENT_OPTIONS, args, FIX);
		const request = requestOf(positionals);
		const session = await openSession(deps, overridesOf(values));
		if (request.action === "prompt") return promptOf(request, session, values);
		const { config } = session;
		const setup = { layers: config.layers, roots: config.roots };
		if (request.action === "probe")
			return probeProfile(request.name, setup, session, values);
		if (request.action === "show")
			return show(
				await resolveUnsettled(request.name, setup),
				undefined,
				session,
				values,
			);
		return ls(setup, deps, values);
	},
};
