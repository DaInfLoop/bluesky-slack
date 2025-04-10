#!/usr/bin/node
// This is meant to be ran as a seperate script, and is not part of the bot at all.
// Why is it in JavaScript when the actual project is TypeScript? Because I'm making this in nano and I don't want to bother typing for a simple helper script.

const postgres = require('postgres');
const { AtpAgent } = require('@atproto/api');

const sql = postgres({ host: '/var/run/postgresql', database: 'haroon_bluesky', username: 'haroon' });
const bsky = new AtpAgent({ service: 'https://api.bsky.app' });

(async () => {
    const subscriptions = await sql`SELECT * FROM subscriptions`;


    for (const subscription of subscriptions) {
        console.log("Updating " + subscription.did)
        const { data } = await bsky.getAuthorFeed({ actor: subscription.did, filter: 'posts_no_replies', limit: 1 });

	console.log(data)

        if (data.feed.length) {
	    await sql`UPDATE latest_posts SET post = ${data.feed[0].post.uri}`;
	} else {
	    await sql`UPDATE latest_posts SET post = ${"at://null"}`;
	}
	console.log("Successfully updated latest post of " + subscription.did)
    }

    console.log("Done!")
    process.exit(0)
})();

