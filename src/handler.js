"use strict";

const {
	DynamoDBClient,
	GetItemCommand,
	PutItemCommand,
} = require("@aws-sdk/client-dynamodb");
const {
	SecretsManagerClient,
	GetSecretValueCommand,
} = require("@aws-sdk/client-secrets-manager");

const fs = require("fs");
const path = require("path");

// The task root is read-only, so the baked icon caches are copied somewhere
// writable before anything imports the renderer and freezes the paths.
seedIconCaches();

const { getPatches } = require("../index.js");
const { run } = require("./post.js");
const { notify } = require("./notify.js");
const { nextPostWindow } = require("./schedule.js");

function seedIconCaches() {
	if (!process.env.AWS_LAMBDA_FUNCTION_NAME) return;

	for (const dir of ["boss_icons", "group_icons"]) {
		const source = path.join(__dirname, "..", dir);
		const target = path.join("/tmp", dir);
		if (!fs.existsSync(target)) {
			fs.mkdirSync(target, { recursive: true });
			if (fs.existsSync(source)) {
				fs.cpSync(source, target, { recursive: true });
			}
		}
		process.env[
			dir === "boss_icons" ? "PATCHY_BOSS_ICONS" : "PATCHY_GROUP_ICONS"
		] = target;
	}
}

const dynamo = new DynamoDBClient({});
const secrets = new SecretsManagerClient({});

const TABLE = process.env.STATE_TABLE;
const SECRET_ID = process.env.SECRET_ID;
const CURSOR_KEY = "cursor";

let secretsLoaded = false;

/**
 * Reddit and Discord credentials live in one Secrets Manager JSON blob and
 * are pushed into the environment, which is where post.js reads them from.
 */
async function loadSecrets() {
	if (secretsLoaded || !SECRET_ID) return;

	const { SecretString } = await secrets.send(
		new GetSecretValueCommand({ SecretId: SECRET_ID }),
	);
	for (const [key, value] of Object.entries(JSON.parse(SecretString || "{}"))) {
		if (value) process.env[key] = String(value);
	}
	secretsLoaded = true;
}

async function getItem(id) {
	const { Item } = await dynamo.send(
		new GetItemCommand({ TableName: TABLE, Key: { id: { S: id } } }),
	);
	if (!Item) return null;
	return Object.fromEntries(
		Object.entries(Item).map(([key, value]) => [key, value.S ?? value.N]),
	);
}

async function putItem(item) {
	await dynamo.send(
		new PutItemCommand({
			TableName: TABLE,
			Item: Object.fromEntries(
				Object.entries(item).map(([key, value]) => [key, { S: String(value) }]),
			),
		}),
	);
}

/**
 * Fires on a schedule and does nothing until wingman's newest patch id
 * changes. When it does, the era that just closed gets posted.
 *
 * Invoke manually with {era, force, dryRun} to override any of that - which
 * is how a run held by the sanity checks gets released once the underlying
 * problem is fixed.
 */
exports.handler = async (event = {}) => {
	await loadSecrets();

	const manualEra = event.era;
	const force = Boolean(event.force);
	const dryRun = Boolean(event.dryRun);

	if (manualEra) {
		const result = await run({ era: manualEra, force, dryRun });
		if (result.status === "posted") {
			await putItem({ id: `era#${result.era}`, status: "posted", url: result.url });
		}
		return result;
	}

	const patches = await getPatches();
	const currentEra = patches.filter((patch) => patch.id !== "all")[0].id;
	const cursor = await getItem(CURSOR_KEY);
	const now = new Date();

	// First ever run: remember where we are, but do not post a backlog.
	if (!cursor) {
		await putItem({ id: CURSOR_KEY, era: currentEra, note: "bootstrap" });
		return { status: "bootstrapped", currentEra };
	}

	// A patch can land at any hour, but the post goes out at a civilised one.
	// Detection and publication are therefore separate ticks.
	if (cursor.era !== currentEra && !cursor.pendingEra) {
		const postAfter = nextPostWindow(now);
		await putItem({
			id: CURSOR_KEY,
			era: currentEra,
			pendingEra: cursor.era,
			postAfter: postAfter.toISOString(),
		});
		return {
			status: "scheduled",
			closedEra: cursor.era,
			currentEra,
			postAfter: postAfter.toISOString(),
		};
	}

	if (!cursor.pendingEra) {
		return { status: "no-change", currentEra };
	}

	if (cursor.postAfter && new Date(cursor.postAfter) > now) {
		return {
			status: "waiting",
			pendingEra: cursor.pendingEra,
			postAfter: cursor.postAfter,
		};
	}

	const closedEra = cursor.pendingEra;

	// Guard against a retry double-posting after a partial failure.
	const already = await getItem(`era#${closedEra}`);
	if (already?.status === "posted") {
		await putItem({ id: CURSOR_KEY, era: currentEra });
		return { status: "already-posted", closedEra, url: already.url };
	}

	let result;
	try {
		result = await run({ era: closedEra, force, dryRun });
	} catch (err) {
		// Leave the cursor alone so the next tick tries again, and say so.
		await notify({
			subject: `Patch-Records failed: era ${closedEra}`,
			body: `${err.message}\n\nStill pending, so the next tick will retry.`,
		});
		throw err;
	}

	if (result.status === "posted") {
		await putItem({ id: `era#${closedEra}`, status: "posted", url: result.url });
	} else {
		await putItem({
			id: `era#${closedEra}`,
			status: result.status,
			problems: (result.problems || []).join(" | ").slice(0, 1000),
		});
	}

	// Clear the pending marker either way: a held era must not re-alert every
	// hour. Releasing it is a manual invoke with {era, force}.
	await putItem({ id: CURSOR_KEY, era: currentEra });

	return { ...result, closedEra, currentEra };
};
