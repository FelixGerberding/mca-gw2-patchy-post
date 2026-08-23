"use strict";

const path = require("path");
const os = require("os");
const fs = require("fs");

const {
	registerFonts,
	getPatches,
	resolveEra,
	fetchTeamData,
	downloadGroupIcons,
	createPatchRecordImage,
	markdownTable,
	sanityCheck,
} = require("../index.js");

const { Reddit, buildDocument } = require("./reddit.js");
const { notify } = require("./notify.js");

const SUBREDDIT = process.env.PATCHY_SUBREDDIT || "Guildwars2";
const FLAIR_TEXT = process.env.PATCHY_FLAIR || "Other";
const FAQ_URL =
	"https://www.reddit.com/r/Guildwars2/comments/16y8xzv/introducing_monthly_raid_patchrecord_recap/";
const FAQ_LABEL = "Introducing Monthly Raid Patch Record Recap";

const TYPES = ["raid", "strike"];

/**
 * Render one encounter type and report both the image and whether it is fit
 * to publish.
 */
async function build(encounterType, era, outDir) {
	const patch = (await getPatches()).find((entry) => entry.id === era);
	const outputPath = path.join(outDir, `${encounterType}_patch_records.png`);

	const {
		teamData,
		newAlltimeRecords,
		teamTableData,
		encounterCount,
		noDataReasons,
	} = await fetchTeamData(encounterType, era);

	await downloadGroupIcons(teamData, false);

	await createPatchRecordImage(
		teamData,
		newAlltimeRecords,
		encounterType,
		era,
		outputPath,
	);

	const { problems, warnings } = sanityCheck({
		teamData,
		teamTableData,
		encounterCount,
		noDataReasons,
		patch,
		era,
	});

	return {
		encounterType,
		outputPath,
		problems,
		warnings,
		table: markdownTable(teamTableData),
		newAlltimeRecords,
	};
}

/**
 * The whole job. Returns a summary describing what it did so the caller (CLI
 * or Lambda) can log or store it.
 */
async function run({ era: requestedEra, dryRun = false, force = false } = {}) {
	registerFonts();

	const era = await resolveEra(requestedEra || "previous");
	const patch = (await getPatches()).find((entry) => entry.id === era);
	const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "patchy-"));

	const builds = [];
	for (const type of TYPES) builds.push(await build(type, era, outDir));

	const tag = (entry, list) =>
		list.map((item) => `[${entry.encounterType}] ${item}`);
	const problems = builds.flatMap((entry) => tag(entry, entry.problems));
	const warnings = builds.flatMap((entry) => tag(entry, entry.warnings));

	const title = `Patch-Records - ${patch.name}`;
	const images = builds.map((entry) => entry.outputPath);

	if (problems.length && !force) {
		await notify({
			subject: `Patch-Records held: ${patch.name}`,
			body:
				`Sanity checks failed for era ${era}, nothing was posted.\n\n` +
				problems.map((problem) => `- ${problem}`).join("\n") +
				(warnings.length
					? `\n\nAlso worth a look:\n${warnings.map((w) => `- ${w}`).join("\n")}`
					: "") +
				`\n\nRe-run with force once these are dealt with.`,
			images,
		});
		return { status: "held", era, title, problems, warnings, images };
	}

	if (dryRun) {
		return { status: "dry-run", era, title, problems, warnings, images, builds };
	}

	const reddit = new Reddit({
		clientId: process.env.REDDIT_CLIENT_ID,
		clientSecret: process.env.REDDIT_CLIENT_SECRET,
		username: process.env.REDDIT_USERNAME,
		password: process.env.REDDIT_PASSWORD,
	});

	const mediaIds = [];
	for (const image of images) mediaIds.push(await reddit.uploadImage(image));

	const flair = await reddit.findFlair(SUBREDDIT, FLAIR_TEXT);

	const { url } = await reddit.submitRichText({
		subreddit: SUBREDDIT,
		title,
		document: buildDocument({
			mediaIds,
			faqUrl: FAQ_URL,
			faqLabel: FAQ_LABEL,
		}),
		flairId: flair?.id,
		flairText: flair ? undefined : FLAIR_TEXT,
	});

	await notify({
		subject: `Patch-Records posted: ${patch.name}`,
		body:
			`${title}\n${url}` +
			(warnings.length
				? `\n\nWorth a look:\n${warnings.map((w) => `- ${w}`).join("\n")}`
				: ""),
		images,
	});

	return { status: "posted", era, title, url, problems, warnings, images };
}

module.exports = { run, build, TYPES };

if (require.main === module) {
	const argv = process.argv.slice(2);
	const opts = {
		era: null,
		dryRun: argv.includes("--dry-run"),
		force: argv.includes("--force"),
	};
	const eraIndex = argv.indexOf("--era");
	if (eraIndex !== -1) opts.era = argv[eraIndex + 1];

	run(opts)
		.then((result) => {
			console.log(`\nstatus: ${result.status}`);
			console.log(`title:  ${result.title}`);
			if (result.url) console.log(`url:    ${result.url}`);
			for (const image of result.images || []) console.log(`image:  ${image}`);
			for (const problem of result.problems || []) console.log(`  ! ${problem}`);
			for (const warning of result.warnings || []) console.log(`  ~ ${warning}`);
			if (result.status === "held") process.exitCode = 3;
		})
		.catch((err) => {
			console.error(err.message);
			process.exit(1);
		});
}
