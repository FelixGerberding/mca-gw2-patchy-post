#!/usr/bin/env node
const { createCanvas, loadImage, registerFont } = require("canvas");
const fs = require("fs");
const path = require("path");

const WINGMAN = "https://gw2wingman.nevermindcreations.de";

// Every post so far was rendered on Windows, where 'Segoe UI' resolves. On
// Linux it silently falls back to whatever sans-serif is installed and the
// post comes out in the wrong typeface, so ship the font with the repo and
// register it under a fixed family name.
const FONT_FAMILY = "Patchy Sans";
const fontDir = path.join(__dirname, "fonts");

function registerFonts() {
	const faces = [
		{ file: "regular.ttf", weight: "normal", style: "normal" },
		{ file: "bold.ttf", weight: "bold", style: "normal" },
		{ file: "italic.ttf", weight: "normal", style: "italic" },
	];

	const found = faces.filter((face) =>
		fs.existsSync(path.join(fontDir, face.file)),
	);

	if (!found.length) {
		console.warn(
			`No fonts in ${path.relative(process.cwd(), fontDir)}/ - falling back to` +
				" the system sans-serif, which will not match previous posts.",
		);
		return false;
	}

	for (const face of found) {
		registerFont(path.join(fontDir, face.file), {
			family: FONT_FAMILY,
			weight: face.weight,
			style: face.style,
		});
	}
	return true;
}

const scaleFactor = 2; // Resolution multiplier
const width = 800 * scaleFactor;
const titleFontSize = 36 * scaleFactor;
const subtitleFontSize = 24 * scaleFactor;
const teamFontSize = 20 * scaleFactor;
const bossIconSize = 32 * scaleFactor;
const padding = 24 * scaleFactor;

// Assets live next to this script, so the tool works from any cwd.
const assetPath = (...parts) => path.join(__dirname, ...parts);
const backgroundImagePath = assetPath("background.jpg");
const cmBadgePath = assetPath("cm_badge.png");
// Overridable because Lambda's task root is read-only - the handler seeds a
// copy under /tmp and points these at it so icon downloads still work.
const bossIconsPath = process.env.PATCHY_BOSS_ICONS || assetPath("boss_icons");
const groupIconsPath =
	process.env.PATCHY_GROUP_ICONS || assetPath("group_icons");

// Bosses whose full name is too long for the "new alltimes" column.
const cleanNames = {
	"Old Lion's Court": "OLC",
	"Old Lion's Court (CM)": "OLC CM",
	"Captain Mai Trin": "Mai Trin",
	"Captain Mai Trin (CM)": "Mai Trin CM",
	"The Voice and The Claw": "Voice & Claw",
	"Spirit Woods": "Spirit Woods",
};

function parseArgs(argv) {
	const opts = {
		encounterType: "raid",
		era: null,
		out: null,
		refreshIcons: false,
		ignoreSanity: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "raid" || arg === "strike") {
			opts.encounterType = arg;
		} else if (arg === "--era") {
			opts.era = argv[++i];
		} else if (arg === "--out") {
			opts.out = argv[++i];
		} else if (arg === "--refresh-icons") {
			opts.refreshIcons = true;
		} else if (arg === "--ignore-sanity") {
			opts.ignoreSanity = true;
		} else if (arg === "--help" || arg === "-h") {
			console.log(
				"Usage: node index.js [raid|strike] [--era <patch-id>] [--out <file.png>]\n" +
					"                    [--refresh-icons] [--ignore-sanity]\n\n" +
					"  raid|strike       Encounter type to chart (default: raid)\n" +
					"  --era             latest (default), previous, or a wingman patch\n" +
					"                    id such as 26-07. \"previous\" is the patch that\n" +
					"                    just closed, i.e. the one with final standings.\n" +
					"  --out             Output PNG path (default: <type>_patch_records.png)\n" +
					"  --refresh-icons   Re-download team icons that are already cached\n" +
					"  --ignore-sanity   Exit 0 even if the sanity checks fail",
			);
			process.exit(0);
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}
	return opts;
}

async function wingman(pathname) {
	const response = await fetch(`${WINGMAN}${pathname}`);
	if (!response.ok) {
		throw new Error(
			`GET ${pathname} failed: ${response.status} ${response.statusText}`,
		);
	}
	return response.json();
}

let patchesCache = null;
async function getPatches() {
	if (!patchesCache) {
		// Newest first, and "all" is a pseudo-patch covering every era.
		patchesCache = (await wingman("/api/patches")).patches;
	}
	return patchesCache;
}

// Icon filenames are derived from boss/team names, so download and render
// have to agree on the slug - they used to differ, which silently lost the
// icon for any name containing punctuation (e.g. "Old Lion's Court").
function slug(name) {
	return name
		.toLowerCase()
		.replace(/ /g, "_")
		.replace(/[^a-z0-9_]/g, "");
}

function bossIconFile(name) {
	return path.join(bossIconsPath, `${slug(name.replace(/ \(CM\)$/, ""))}.png`);
}

function teamIconFile(team) {
	return path.join(groupIconsPath, `${slug(team)}_icon.png`);
}

/**
 * Selawik has no italic face and canvas will not synthesise one - asking for
 * "italic" just renders upright - so slant it by hand. The shear is applied
 * about the baseline origin so the text does not drift off its anchor.
 */
function fillTextOblique(ctx, text, x, y, slant = 0.21) {
	ctx.save();
	ctx.translate(x, y);
	ctx.transform(1, 0, -slant, 1, 0, 0);
	ctx.fillText(text, 0, 0);
	ctx.restore();
}

function getCleanName(name, isChallengeMode) {
	if (cleanNames[name]) {
		return cleanNames[name];
	}
	return name.split(" ")[0] + (isChallengeMode ? " CM" : "");
}

function formatDuration(ms) {
	const totalSeconds = ms / 1000;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = Math.floor(totalSeconds % 60);
	return `${minutes}:${seconds < 10 ? "0" + seconds : seconds}`;
}

/**
 * "latest" is the patch currently being played, "previous" is the one that
 * just closed - which is the one a "Final Standings" post is about. Anything
 * else is taken as a literal wingman patch id.
 */
async function resolveEra(era) {
	const patches = await getPatches();
	const live = patches.filter((patch) => patch.id !== "all");

	if (!era || era === "latest" || era === "current") return live[0].id;
	if (era === "previous") {
		if (live.length < 2) throw new Error("No previous patch to report on");
		return live[1].id;
	}
	if (!live.some((patch) => patch.id === era)) {
		throw new Error(`Unknown patch era: ${era}`);
	}
	return era;
}

/**
 * Best time this boss was ever killed in *before* the era we are charting.
 * Returns null when there is no earlier kill, i.e. the record is brand new.
 */
async function getPreviousBestTime(bossID, era) {
	const patches = await getPatches();
	const eraIndex = patches.findIndex((patch) => patch.id === era);

	const earlier = patches
		.slice(0, 30)
		.filter(
			(patch, index) =>
				patch.id !== "all" && (eraIndex === -1 || index > eraIndex),
		);

	const times = await Promise.all(
		earlier.map(async (patch) => {
			const patchData = await wingman(
				`/api/boss?bossID=${bossID}&era=${patch.id}`,
			);
			return patchData.duration_top;
		}),
	);

	const valid = times
		.filter((time) => typeof time === "number" && time > 0)
		.sort((a, b) => a - b);

	return valid.length ? valid[0] : null;
}

async function downloadBossIcon(boss) {
	try {
		fs.mkdirSync(bossIconsPath, { recursive: true });

		const filePath = bossIconFile(boss.name);
		if (fs.existsSync(filePath)) return filePath;

		const response = await fetch(`${WINGMAN}${boss.icon}`);
		if (!response.ok) {
			throw new Error(
				`Failed to fetch: ${response.status} ${response.statusText}`,
			);
		}

		fs.writeFileSync(filePath, Buffer.from(await response.arrayBuffer()));
		return filePath;
	} catch (err) {
		console.error(`Error downloading icon for ${boss.name}:`, err.message);
		return null;
	}
}

function decodeHtml(text) {
	return text
		.replace(/&#0?39;|&#x27;/gi, "'")
		.replace(/&quot;/g, '"')
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");
}

/**
 * Wingman hosts the team logos, but under arbitrary filenames - "Snow Crows"
 * is served as SC.png, "My Chaotic Asylum" as MCA_LOGO_2.png. The group name
 * only appears in the img title, so scrape it off one of the team's own
 * record log pages and cache the result under our own slug.
 */
async function downloadGroupIcon(team, logLink, refresh) {
	const filePath = teamIconFile(team);
	if (!refresh && fs.existsSync(filePath)) return;

	try {
		const response = await fetch(`${WINGMAN}/log/${logLink}`);
		if (!response.ok) {
			throw new Error(`log page returned ${response.status}`);
		}
		const html = await response.text();

		let iconFile = null;
		for (const match of html.matchAll(
			/groupIcons\/([^"]+)"[^>]*?title="([^"]*)"/g,
		)) {
			if (decodeHtml(match[2]) === team) {
				iconFile = match[1];
				break;
			}
		}

		if (!iconFile) {
			console.warn(`No wingman icon for "${team}"`);
			return;
		}

		const icon = await fetch(`${WINGMAN}/static/groupIcons/${iconFile}`);
		if (!icon.ok) {
			throw new Error(`icon returned ${icon.status}`);
		}

		fs.mkdirSync(groupIconsPath, { recursive: true });
		fs.writeFileSync(filePath, Buffer.from(await icon.arrayBuffer()));
		console.log(`Fetched team icon for "${team}" (${iconFile})`);
	} catch (err) {
		console.warn(`Could not fetch team icon for "${team}": ${err.message}`);
	}
}

async function downloadGroupIcons(teamData, refresh) {
	for (const team of teamData) {
		await downloadGroupIcon(team.team, team.logLink, refresh);
	}
}

async function processBoss(bossID, isChallengeMode, boss, era) {
	try {
		const currentData = await wingman(`/api/boss?bossID=${bossID}&era=${era}`);

		// Wingman answers 200 with an {error} body when it holds nothing for
		// this boss/era combination - a whole era can be missing this way.
		if (currentData.error) return { noData: currentData.error };

		// Not every encounter gets killed every patch (Freezie, for one).
		if (!currentData.link_top || !currentData.duration_top) return null;

		const alltimeData = await wingman(`/api/boss?bossID=${bossID}&era=all`);

		await downloadBossIcon(boss);

		return {
			bossID,
			name: isChallengeMode ? `${boss.name} (CM)` : boss.name,
			players: currentData.group_top?.[0] || "",
			time: formatDuration(currentData.duration_top),
			duration: currentData.duration_top,
			link: currentData.link_top,
			logUrl: `${WINGMAN}/log/${currentData.link_top}`,
			isChallengeMode,
			isAllTime: currentData.link_top === alltimeData.link_top,
		};
	} catch (error) {
		console.error(`Error processing boss ${boss.name}:`, error.message);
		return null;
	}
}

function processTeamData(bossEntry, teamDataMap) {
	if (!bossEntry.players) return;

	const groupName = bossEntry.players;
	if (!teamDataMap[groupName]) {
		// Any one of the team's logs will do to look their icon up later.
		teamDataMap[groupName] = {
			team: groupName,
			logLink: bossEntry.link,
			bosses: [],
		};
	}

	teamDataMap[groupName].bosses.push({
		name: bossEntry.name,
		isChallengeMode: bossEntry.isChallengeMode,
	});
}

async function collectRecord(bossID, isChallengeMode, boss, era) {
	const data = await processBoss(bossID, isChallengeMode, boss, era);
	if (!data) return null;
	if (data.noData) return { noData: data.noData };

	if (!data.isAllTime) return { data, alltime: null };

	const previousTime = await getPreviousBestTime(bossID, era);
	const improvement = previousTime === null ? null : data.duration - previousTime;
	return { data, alltime: { improvement, ...data } };
}

async function fetchTeamData(encounterType, era) {
	const bossesData = await wingman("/api/bosses");

	const bosses = Object.entries(bossesData)
		.filter(([id, boss]) => boss.type === encounterType && parseInt(id) > 0)
		.sort((a, b) => a[1].sort - b[1].sort);

	const teamDataMap = {};
	const newAlltimeRecords = [];
	const teamTableData = [];

	let encounterCount = 0;
	const noDataReasons = new Set();
	for (const [bossID, boss] of bosses) {
		const variants = [[bossID, false]];
		if (boss.hasCM) variants.push([`-${bossID}`, true]);
		encounterCount += variants.length;

		for (const [id, isChallengeMode] of variants) {
			const result = await collectRecord(id, isChallengeMode, boss, era);
			if (!result) continue;
			if (result.noData) {
				noDataReasons.add(result.noData);
				continue;
			}

			teamTableData.push(result.data);
			processTeamData(result.data, teamDataMap);
			if (result.alltime) newAlltimeRecords.push(result.alltime);
		}
	}

	const teamData = Object.values(teamDataMap).sort(
		(a, b) => b.bosses.length - a.bosses.length,
	);

	// Teams with the same boss count share a rank, and the next rank skips
	// ahead (1, 2, 2, 4) - standard competition ranking.
	let previousCount = null;
	let rank = 1;
	teamData.forEach((team, index) => {
		if (team.bosses.length !== previousCount) {
			rank = index + 1;
			previousCount = team.bosses.length;
		}
		team.rank = rank;
	});

	return {
		teamData,
		newAlltimeRecords,
		teamTableData,
		encounterCount,
		noDataReasons: [...noDataReasons],
	};
}

function markdownTable(teamTableData) {
	const rows = teamTableData
		.map(
			(entry) =>
				`| ${entry.name} | ${entry.players} | ${entry.time} | [Log](${entry.logUrl}) |`,
		)
		.join("\n");

	return `| Boss | Team | Time | Log URL |\n|------|------|------|---------|\n${rows}`;
}

async function loadOptionalImage(filePath, label) {
	try {
		return await loadImage(filePath);
	} catch {
		console.warn(`Missing ${label}: ${path.basename(filePath)}`);
		return null;
	}
}

/**
 * Draws a team's boss icons in a grid, wrapping every `iconsPerRow`.
 * Returns the number of extra rows used beyond the first.
 */
async function drawBossIcons(ctx, bosses, startX, startY, iconsPerRow, cmIcon) {
	let iconX = startX;
	let iconY = startY;
	let currentRow = 0;

	for (const [index, boss] of bosses.entries()) {
		if (index > 0 && index % iconsPerRow === 0) {
			currentRow++;
			iconX = startX;
			iconY = startY + currentRow * (bossIconSize + 15 * scaleFactor);
		}

		const bossIcon = await loadOptionalImage(
			bossIconFile(boss.name),
			"boss icon",
		);
		if (!bossIcon) continue;

		ctx.beginPath();
		ctx.roundRect(
			iconX - 2 * scaleFactor,
			iconY - 2 * scaleFactor,
			bossIconSize + 4 * scaleFactor,
			bossIconSize + 4 * scaleFactor,
			6 * scaleFactor,
		);
		ctx.fillStyle = "rgba(0, 0, 0, 0.4)";
		ctx.fill();

		ctx.drawImage(bossIcon, iconX, iconY, bossIconSize, bossIconSize);

		if (boss.isChallengeMode && cmIcon) {
			ctx.drawImage(
				cmIcon,
				iconX + 14 * scaleFactor,
				iconY + 18 * scaleFactor,
				16 * scaleFactor,
				12 * scaleFactor,
			);
		}

		iconX += bossIconSize + 10 * scaleFactor;
	}

	return currentRow;
}

async function createPatchRecordImage(
	data,
	newAlltimeRecords,
	encounterType,
	era,
	outputPath,
) {
	const patches = await getPatches();
	const patch = patches.find((entry) => entry.id === era) || patches[0];

	const top3 = data.slice(0, 3);
	const otherTeams = data.slice(3);

	const teamAreaWidth = width - 250 * scaleFactor - padding * 2;
	const columnWidth = (teamAreaWidth - 20 * scaleFactor) / 2;
	const top3IconsPerRow = Math.floor(
		(teamAreaWidth - 60 * scaleFactor) / (bossIconSize + 10 * scaleFactor),
	);
	const otherTeamsIconsPerRow = Math.floor(
		(columnWidth - 60 * scaleFactor) / (bossIconSize + 10 * scaleFactor),
	);

	const extraHeight = (teams, iconsPerRow) =>
		teams.reduce((total, team) => {
			const rowsNeeded = Math.ceil(team.bosses.length / iconsPerRow);
			return (
				total +
				(rowsNeeded > 1
					? (rowsNeeded - 1) * (bossIconSize + 15) * scaleFactor
					: 0)
			);
		}, 0);

	const baseHeight =
		100 * scaleFactor + // Header space
		top3.length * 85 * scaleFactor + // Top 3 teams base height
		extraHeight(top3, top3IconsPerRow) + // Wrapped rows in the top 3
		Math.ceil(otherTeams.length / 2) * 85 * scaleFactor + // Other teams base height
		Math.ceil(extraHeight(otherTeams, otherTeamsIconsPerRow) / 2) + // Wrapped rows, split over 2 columns
		100 * scaleFactor; // Buffer

	const canvas = createCanvas(width, baseHeight);
	const ctx = canvas.getContext("2d");

	const backgroundImage = await loadImage(backgroundImagePath);
	ctx.drawImage(backgroundImage, 0, 0, width, baseHeight);

	const gradient = ctx.createLinearGradient(0, 0, width, baseHeight);
	gradient.addColorStop(0, "rgba(25, 25, 35, 0.85)");
	gradient.addColorStop(1, "rgba(10, 10, 20, 0.9)");
	ctx.fillStyle = gradient;
	ctx.fillRect(0, 0, width, baseHeight);

	ctx.strokeStyle = "rgba(255, 255, 255, 0.15)";
	ctx.lineWidth = 4 * scaleFactor;
	ctx.strokeRect(2, 2, width - 4, baseHeight - 4);

	ctx.font = `bold ${titleFontSize}px '${FONT_FAMILY}', sans-serif`;
	ctx.fillStyle = "#efbf04";
	ctx.shadowColor = "rgba(0, 0, 0, 0.5)";
	ctx.shadowBlur = 8 * scaleFactor;
	const titleY = padding + titleFontSize;
	ctx.fillText(
		"PATCH RECORDS",
		width / 2 - ctx.measureText("PATCH RECORDS").width / 2,
		titleY,
	);

	ctx.font = `italic ${subtitleFontSize}px '${FONT_FAMILY}', sans-serif`;
	ctx.fillStyle = "#ffffff";
	ctx.shadowBlur = 4 * scaleFactor;
	const subtitleText = `${encounterType[0].toUpperCase() + encounterType.slice(1)}s • ${patch.name.replace(/Balance Patch /g, "")} Patch • Final Standings`;
	fillTextOblique(
		ctx,
		subtitleText,
		width / 2 - ctx.measureText(subtitleText).width / 2,
		titleY + subtitleFontSize + 10 * scaleFactor,
	);

	ctx.beginPath();
	ctx.strokeStyle = "rgba(255, 215, 0, 0.4)";
	ctx.lineWidth = 2 * scaleFactor;
	ctx.moveTo(padding, titleY + subtitleFontSize + 30 * scaleFactor);
	ctx.lineTo(width - padding, titleY + subtitleFontSize + 30 * scaleFactor);
	ctx.stroke();

	const teamStartY = titleY + subtitleFontSize + 50 * scaleFactor;
	let currentY = teamStartY;

	const rankColors = ["#efbf04", "#c0c0c0", "#cd7f32"];
	const cmIcon = await loadOptionalImage(cmBadgePath, "CM badge");

	for (const [index, team] of top3.entries()) {
		ctx.fillStyle = rankColors[index];
		ctx.beginPath();
		ctx.roundRect(
			padding + 10 * scaleFactor,
			currentY + 10 * scaleFactor,
			40 * scaleFactor,
			40 * scaleFactor,
			8 * scaleFactor,
		);
		ctx.fill();

		ctx.font = `bold ${24 * scaleFactor}px '${FONT_FAMILY}'`;
		ctx.fillStyle = "#ffffff";
		ctx.textAlign = "center";
		ctx.fillText(
			team.rank.toString(),
			padding + 30 * scaleFactor,
			currentY + 38 * scaleFactor,
		);

		ctx.font = `bold ${22 * scaleFactor}px '${FONT_FAMILY}'`;
		ctx.fillStyle = "#ffffff";
		ctx.textAlign = "left";
		ctx.fillText(team.team, padding + 60 * scaleFactor, currentY + 35 * scaleFactor);

		const teamIcon = await loadOptionalImage(
			teamIconFile(team.team),
			`team icon for "${team.team}"`,
		);
		if (teamIcon) {
			ctx.drawImage(
				teamIcon,
				// Measured with the rank prefix so the icon clears the widest
				// possible name; keep as-is or every past post shifts.
				padding * 2 +
					ctx.measureText(`${team.rank}. ${team.team}`).width +
					16 * scaleFactor,
				currentY + 18 * scaleFactor,
				teamFontSize,
				teamFontSize,
			);
		}

		const currentRow = await drawBossIcons(
			ctx,
			team.bosses,
			padding + 60 * scaleFactor,
			currentY + 45 * scaleFactor,
			top3IconsPerRow,
			cmIcon,
		);

		currentY +=
			85 * scaleFactor +
			(currentRow > 0 ? currentRow * bossIconSize * scaleFactor : 0);
	}

	let leftColumnY = currentY;
	let rightColumnY = currentY;

	for (const [index, team] of otherTeams.entries()) {
		const isLeftColumn = index % 2 === 0;
		const xPos = isLeftColumn
			? padding
			: padding + columnWidth + 20 * scaleFactor;
		const yPos = isLeftColumn ? leftColumnY : rightColumnY;

		ctx.fillStyle = "#404040";
		ctx.beginPath();
		ctx.roundRect(
			xPos + 10 * scaleFactor,
			yPos + 10 * scaleFactor,
			40 * scaleFactor,
			40 * scaleFactor,
			8 * scaleFactor,
		);
		ctx.fill();

		ctx.font = `bold ${24 * scaleFactor}px '${FONT_FAMILY}'`;
		ctx.fillStyle = "#ffffff";
		ctx.textAlign = "center";
		ctx.fillText(
			team.rank.toString(),
			xPos + 30 * scaleFactor,
			yPos + 38 * scaleFactor,
		);

		ctx.font = `bold ${18 * scaleFactor}px '${FONT_FAMILY}'`;
		ctx.fillStyle = "#ffffff";
		ctx.textAlign = "left";
		const teamName =
			team.team.length > 18 ? team.team.substring(0, 18) + "..." : team.team;
		ctx.fillText(teamName, xPos + 60 * scaleFactor, yPos + 35 * scaleFactor);

		const teamIcon = await loadOptionalImage(
			teamIconFile(team.team),
			`team icon for "${team.team}"`,
		);
		if (teamIcon) {
			ctx.drawImage(
				teamIcon,
				xPos +
					60 * scaleFactor +
					ctx.measureText(teamName).width +
					8 * scaleFactor,
				yPos + 18 * scaleFactor,
				teamFontSize,
				teamFontSize,
			);
		}

		const currentRow = await drawBossIcons(
			ctx,
			team.bosses,
			xPos + 60 * scaleFactor,
			yPos + 45 * scaleFactor,
			otherTeamsIconsPerRow,
			cmIcon,
		);

		const advance =
			85 * scaleFactor +
			(currentRow > 0 ? currentRow * (bossIconSize + 15) * scaleFactor : 0);
		if (isLeftColumn) {
			leftColumnY += advance;
		} else {
			rightColumnY += advance;
		}
	}

	currentY = Math.max(leftColumnY, rightColumnY);

	const recordsX = width - 260 * scaleFactor + padding;
	ctx.fillStyle = "rgba(0, 0, 0, 0.3)";
	ctx.beginPath();
	ctx.roundRect(
		recordsX,
		teamStartY,
		250 * scaleFactor - padding * 2,
		currentY - teamStartY,
		12 * scaleFactor,
	);
	ctx.fill();

	ctx.font = `bold ${24 * scaleFactor}px '${FONT_FAMILY}'`;
	ctx.fillStyle = "#66ff66";
	ctx.fillText(
		"NEW ALLTIMES",
		recordsX + 17 * scaleFactor,
		teamStartY + 30 * scaleFactor,
	);

	let contentY = teamStartY + 50 * scaleFactor;
	for (const record of newAlltimeRecords) {
		const bossIcon = await loadOptionalImage(
			bossIconFile(record.name),
			"boss icon",
		);
		if (bossIcon) {
			ctx.drawImage(
				bossIcon,
				recordsX + 15 * scaleFactor,
				contentY,
				bossIconSize,
				bossIconSize,
			);
		}

		if (record.isChallengeMode && cmIcon) {
			ctx.drawImage(
				cmIcon,
				recordsX + 14 * scaleFactor,
				contentY + 18 * scaleFactor,
				16 * scaleFactor,
				12 * scaleFactor,
			);
		}

		ctx.font = `bold ${16 * scaleFactor}px '${FONT_FAMILY}'`;
		ctx.fillStyle = "#ffffff";
		ctx.fillText(
			getCleanName(record.name, record.isChallengeMode),
			recordsX + 60 * scaleFactor,
			contentY + 15 * scaleFactor,
		);

		ctx.font = `${14 * scaleFactor}px '${FONT_FAMILY}'`;
		ctx.fillStyle = "#cccccc";
		ctx.fillText(
			`Time: ${record.time}`,
			recordsX + 60 * scaleFactor,
			contentY + 30 * scaleFactor,
		);

		// No earlier kill on record means the encounter is new this patch.
		const improvementText =
			record.improvement === null
				? "(new)"
				: `-${Math.abs(record.improvement / 1000).toFixed(2)}s`;

		ctx.fillStyle = "#66ff66";
		ctx.fillText(
			improvementText,
			ctx.measureText(`Time: ${record.time} `).width +
				recordsX +
				60 * scaleFactor,
			contentY + 30 * scaleFactor,
		);

		contentY += 60 * scaleFactor;
	}

	fs.writeFileSync(outputPath, canvas.toBuffer("image/png"));
}

/**
 * Cheap guards against publishing a broken post when wingman is having a bad
 * day. Anything in the returned list means a human should look before this
 * goes out.
 */
function sanityCheck({
	teamData,
	teamTableData,
	encounterCount,
	noDataReasons,
	patch,
	era,
}) {
	const problems = [];
	const warnings = [];

	if (!teamTableData.length) {
		problems.push(
			`No records at all for era ${era}` +
				(noDataReasons.length
					? ` - wingman says: ${noDataReasons.join("; ")}`
					: ""),
		);
	} else if (teamTableData.length < encounterCount * 0.5) {
		problems.push(
			`Only ${teamTableData.length} of ${encounterCount} encounters have a` +
				` record for era ${era} - wingman may be mid-outage`,
		);
	}

	if (teamData.length < 3) {
		problems.push(
			`Only ${teamData.length} team(s) in the standings - the layout expects` +
				" a top 3",
		);
	}

	// "Final Standings" is a lie while the patch is still being played.
	if (patch.until && new Date(patch.until) > new Date()) {
		problems.push(
			`Patch ${era} is still open (until ${patch.until}) - standings are not final`,
		);
	}

	// Plenty of teams never upload a logo to wingman, so a missing icon is
	// normal and cosmetic. Worth saying out loud, not worth holding the post.
	const noIcon = teamData.filter(
		(team) => !fs.existsSync(teamIconFile(team.team)),
	);
	if (noIcon.length) {
		warnings.push(
			`No team icon for: ${noIcon.map((team) => team.team).join(", ")}`,
		);
	}

	return { problems, warnings };
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	registerFonts();

	const era = await resolveEra(opts.era);
	const patch = (await getPatches()).find((entry) => entry.id === era);
	const outputPath = opts.out || `${opts.encounterType}_patch_records.png`;

	console.log(
		`Building ${opts.encounterType} patch records for era ${era} (${patch.name})`,
	);

	const {
		teamData,
		newAlltimeRecords,
		teamTableData,
		encounterCount,
		noDataReasons,
	} = await fetchTeamData(opts.encounterType, era);

	await downloadGroupIcons(teamData, opts.refreshIcons);

	console.log(`\n${markdownTable(teamTableData)}\n`);
	console.log(
		`New alltime records: ${
			newAlltimeRecords.map((record) => record.name).join(", ") || "none"
		}`,
	);

	await createPatchRecordImage(
		teamData,
		newAlltimeRecords,
		opts.encounterType,
		era,
		outputPath,
	);
	console.log(`Image saved to: ${outputPath}`);

	const problems = sanityCheck({
		teamData,
		teamTableData,
		encounterCount,
		noDataReasons,
		patch,
		era,
	});

	if (problems.length) {
		console.warn("\nSanity checks failed:");
		for (const problem of problems) console.warn(`  - ${problem}`);
	} else {
		console.log("\nSanity checks passed.");
	}

	// The image is always written so it can be eyeballed; the exit code is
	// what an automated caller gates on.
	if (problems.length && !opts.ignoreSanity) process.exitCode = 3;
}

module.exports = {
	registerFonts,
	getPatches,
	resolveEra,
	fetchTeamData,
	downloadGroupIcons,
	createPatchRecordImage,
	markdownTable,
	sanityCheck,
};

// Only run as a CLI; the Lambda handler imports the pieces above instead.
if (require.main === module) {
	main().catch((err) => {
		console.error(err.message);
		process.exit(1);
	});
}
