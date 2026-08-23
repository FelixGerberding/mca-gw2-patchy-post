"use strict";

const fs = require("fs");
const path = require("path");

/**
 * Discord webhook notification. Images ride along as real attachments so a
 * held post can be eyeballed straight from the channel without digging into
 * S3 or CloudWatch.
 */
async function notify({ subject, body, images = [] }) {
	const webhook = process.env.DISCORD_WEBHOOK_URL;
	if (!webhook) {
		console.warn("DISCORD_WEBHOOK_URL unset - skipping notification");
		console.log(`${subject}\n${body}`);
		return false;
	}

	const form = new FormData();
	form.append(
		"payload_json",
		JSON.stringify({
			username: "Patch-Records",
			// Suppress pings; this is informational.
			allowed_mentions: { parse: [] },
			content: `**${subject}**\n${body}`.slice(0, 1900),
		}),
	);

	images.slice(0, 10).forEach((image, index) => {
		if (!fs.existsSync(image)) return;
		form.append(
			`files[${index}]`,
			new Blob([fs.readFileSync(image)], { type: "image/png" }),
			path.basename(image),
		);
	});

	const response = await fetch(webhook, { method: "POST", body: form });
	if (!response.ok) {
		// A failed notification must not take the whole run down with it.
		console.error(
			`Discord webhook failed (${response.status}): ${await response
				.text()
				.catch(() => "")}`.slice(0, 300),
		);
		return false;
	}
	return true;
}

module.exports = { notify };
