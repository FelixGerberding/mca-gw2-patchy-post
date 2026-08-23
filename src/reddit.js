"use strict";

const fs = require("fs");
const path = require("path");

const OAUTH = "https://oauth.reddit.com";
const WWW = "https://www.reddit.com";

/**
 * Minimal Reddit client for the one thing this repo needs: put a post with
 * two images and a line of text on r/Guildwars2 once a patch.
 *
 * Uses the "script" app password grant, which is the only flow that works
 * without a browser redirect. The app must be registered as type "script" and
 * the account must be listed as a developer on it.
 */
class Reddit {
	constructor({ clientId, clientSecret, username, password, userAgent }) {
		if (!clientId || !clientSecret || !username || !password) {
			throw new Error("Reddit credentials incomplete");
		}
		this.clientId = clientId;
		this.clientSecret = clientSecret;
		this.username = username;
		this.password = password;
		// Reddit asks for a descriptive UA and rate-limits generic ones harder.
		this.userAgent =
			userAgent || `nodejs:patchy-post:1.0.0 (by /u/${username})`;
		this.token = null;
	}

	async authenticate() {
		const body = new URLSearchParams({
			grant_type: "password",
			username: this.username,
			password: this.password,
		});

		const auth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString(
			"base64",
		);

		const response = await fetch(`${WWW}/api/v1/access_token`, {
			method: "POST",
			headers: {
				Authorization: `Basic ${auth}`,
				"Content-Type": "application/x-www-form-urlencoded",
				"User-Agent": this.userAgent,
			},
			body,
		});

		const json = await response.json().catch(() => ({}));
		if (!response.ok || !json.access_token) {
			throw new Error(
				`Reddit auth failed (${response.status}): ${
					json.error || JSON.stringify(json).slice(0, 200)
				}`,
			);
		}

		this.token = json.access_token;
		return this.token;
	}

	async call(pathname, { method = "GET", form, retries = 3 } = {}) {
		if (!this.token) await this.authenticate();

		for (let attempt = 0; attempt < retries; attempt++) {
			const response = await fetch(`${OAUTH}${pathname}`, {
				method,
				headers: {
					Authorization: `Bearer ${this.token}`,
					"User-Agent": this.userAgent,
					...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
				},
				body: form ? new URLSearchParams(form) : undefined,
			});

			// 429 carries a reset hint; anything 5xx is worth one more go.
			if (response.status === 429 || response.status >= 500) {
				const wait = Number(response.headers.get("x-ratelimit-reset")) || 5;
				await sleep(Math.min(wait, 60) * 1000);
				continue;
			}

			const text = await response.text();
			let json;
			try {
				json = JSON.parse(text);
			} catch {
				throw new Error(
					`Reddit ${pathname} returned non-JSON (${response.status}): ${text.slice(0, 200)}`,
				);
			}

			if (!response.ok) {
				throw new Error(`Reddit ${pathname} failed (${response.status})`);
			}
			return json;
		}

		throw new Error(`Reddit ${pathname} still failing after ${retries} tries`);
	}

	/**
	 * Reddit will not take image bytes on the submit call. You ask for an
	 * upload lease, POST the file to the S3 form it hands back, and then refer
	 * to the returned asset id when submitting.
	 */
	async uploadImage(filePath) {
		const filename = path.basename(filePath);
		const mimeType = filename.endsWith(".jpg") ? "image/jpeg" : "image/png";

		const lease = await this.call("/api/media/asset.json", {
			method: "POST",
			form: { filepath: filename, mimetype: mimeType },
		});

		const args = lease?.args;
		const assetId = lease?.asset?.asset_id;
		if (!args?.action || !assetId) {
			throw new Error(
				`Unexpected upload lease shape: ${JSON.stringify(lease).slice(0, 300)}`,
			);
		}

		const uploadUrl = args.action.startsWith("//")
			? `https:${args.action}`
			: args.action;

		const form = new FormData();
		for (const field of args.fields) form.append(field.name, field.value);
		form.append(
			"file",
			new Blob([fs.readFileSync(filePath)], { type: mimeType }),
			filename,
		);

		const upload = await fetch(uploadUrl, { method: "POST", body: form });
		if (!upload.ok) {
			throw new Error(
				`Image upload failed (${upload.status}) for ${filename}`,
			);
		}

		return assetId;
	}

	/**
	 * A gallery submission takes captions but no body text, and a plain image
	 * submission takes neither. The established post has two images AND a line
	 * of text, so it has to be a self post whose body is richtext with the
	 * images embedded.
	 */
	async submitRichText({ subreddit, title, document, flairId, flairText }) {
		const form = {
			sr: subreddit,
			kind: "self",
			title,
			richtext_json: JSON.stringify({ document }),
			api_type: "json",
			// Never silently replace an existing post with the same title.
			resubmit: "false",
			sendreplies: "true",
			nsfw: "false",
			spoiler: "false",
		};
		if (flairId) form.flair_id = flairId;
		if (flairText) form.flair_text = flairText;

		const result = await this.call("/api/submit", { method: "POST", form });

		const errors = result?.json?.errors;
		if (errors?.length) {
			throw new Error(`Reddit rejected the post: ${JSON.stringify(errors)}`);
		}

		const url = result?.json?.data?.url;
		const id = result?.json?.data?.id;
		if (!url) {
			throw new Error(
				`Submit returned no url: ${JSON.stringify(result).slice(0, 300)}`,
			);
		}
		return { url, id };
	}

	/** Flair ids are per-subreddit and change, so look the wanted one up by text. */
	async findFlair(subreddit, wantedText) {
		const flairs = await this.call(
			`/r/${subreddit}/api/link_flair_v2`,
		).catch(() => null);

		if (!Array.isArray(flairs)) return null;

		const normalise = (s) => String(s || "").replace(/[[\]\s]/g, "").toLowerCase();
		const wanted = normalise(wantedText);
		return flairs.find((flair) => normalise(flair.text) === wanted) || null;
	}
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The post body: the images stacked, then the standing pointer at the FAQ.
 * `mediaIds` are asset ids from uploadImage, in display order.
 */
function buildDocument({ mediaIds, faqUrl, faqLabel }) {
	return [
		...mediaIds.map((id) => ({ e: "img", id })),
		{
			e: "par",
			c: [
				{
					e: "text",
					t:
						"New here and wondering what this is all about? Check out the" +
						" original announcement and FAQ: ",
				},
				{ e: "link", t: faqLabel, u: faqUrl },
			],
		},
	];
}

module.exports = { Reddit, buildDocument };
