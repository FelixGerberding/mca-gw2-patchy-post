#!/usr/bin/env node
"use strict";

const cdk = require("aws-cdk-lib");
const { PatchyPostStack } = require("../lib/patchy-post-stack.js");

const app = new cdk.App();

new PatchyPostStack(app, "PatchyPostStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || "eu-central-1",
  },
  description: "Posts the GW2 Patch-Records recap to Reddit when a patch ends",
});
