"use strict";

const path = require("path");
const cdk = require("aws-cdk-lib");
const lambda = require("aws-cdk-lib/aws-lambda");
const dynamodb = require("aws-cdk-lib/aws-dynamodb");
const events = require("aws-cdk-lib/aws-events");
const targets = require("aws-cdk-lib/aws-events-targets");
const secretsmanager = require("aws-cdk-lib/aws-secretsmanager");
const logs = require("aws-cdk-lib/aws-logs");

class PatchyPostStack extends cdk.Stack {
	constructor(scope, id, props) {
		super(scope, id, props);

		// Credentials are filled in by hand after the first deploy - CDK only
		// creates the empty shell so nothing secret lands in the template.
		const secret = new secretsmanager.Secret(this, "Credentials", {
			secretName: "patchy-post/credentials",
			description:
				"REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_USERNAME," +
				" REDDIT_PASSWORD, DISCORD_WEBHOOK_URL",
		});

		// One row holds the cursor (the patch id last seen), the rest are one
		// per era recording whether it was posted or held.
		const table = new dynamodb.Table(this, "State", {
			partitionKey: { name: "id", type: dynamodb.AttributeType.STRING },
			billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
			removalPolicy: cdk.RemovalPolicy.RETAIN,
			pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
		});

		const logGroup = new logs.LogGroup(this, "PosterLogs", {
			retention: logs.RetentionDays.ONE_MONTH,
			removalPolicy: cdk.RemovalPolicy.DESTROY,
		});

		// canvas needs cairo and pango, so this is a container image rather
		// than a zip. The render walks every boss serially against wingman,
		// which is slow but nowhere near the 15 minute ceiling.
		const fn = new lambda.DockerImageFunction(this, "Poster", {
			code: lambda.DockerImageCode.fromImageAsset(
				path.join(__dirname, "..", ".."),
			),
			memorySize: 2048,
			timeout: cdk.Duration.minutes(15),
			logGroup,
			environment: {
				STATE_TABLE: table.tableName,
				SECRET_ID: secret.secretName,
				PATCHY_SUBREDDIT: "Guildwars2",
				PATCHY_FLAIR: "Other",
			},
		});

		table.grantReadWriteData(fn);
		secret.grantRead(fn);

		// Wingman publishes a new patch id within minutes of the patch landing;
		// hourly picks it up the same day without hammering anyone.
		new events.Rule(this, "PatchWatch", {
			schedule: events.Schedule.rate(cdk.Duration.hours(1)),
			targets: [new targets.LambdaFunction(fn)],
			description: "Checks whether wingman's newest patch id has changed",
		});

		new cdk.CfnOutput(this, "FunctionName", { value: fn.functionName });
		new cdk.CfnOutput(this, "SecretName", { value: secret.secretName });
		new cdk.CfnOutput(this, "TableName", { value: table.tableName });
	}
}

module.exports = { PatchyPostStack };
