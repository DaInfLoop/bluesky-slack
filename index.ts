const { App, ExpressReceiver } = (await import("@slack/bolt"));
import { type LinkUnfurls } from "@slack/web-api";
import { AtpAgent } from "@atproto/api";
import "dotenv/config";
import { Assistant, type AllMiddlewareArgs, type Context, type SlackCommandMiddlewareArgs, type StringIndexed } from "@slack/bolt";

import postgres from "postgres";
import type { PostView } from "@atproto/api/dist/client/types/app/bsky/feed/defs";
const sql = postgres({
    host: '/var/run/postgresql',
    database: 'haroon_bluesky',
    username: 'haroon'
})

const receiver = new ExpressReceiver({ signingSecret: process.env.SLACK_SIGNING_SECRET! })
const bsky = new AtpAgent({ service: 'https://api.bsky.app' });

const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    receiver
});

receiver.router.use((req, res, next) => {
    console.log(req.method, req.url)
    next()
})

const bskyPostRegex = /https:\/\/bsky.app\/profile\/(.+)\/post\/(.+)/
const bskyUserRegex = /^https:\/\/bsky\.app\/profile\/([^\/]+)\/?$/m

async function resolveHandle(handle: string): Promise<string | null> {
    const origin = `https://${handle}`
    const res = await bsky.com.atproto.identity.resolveHandle({ handle });

    if (typeof res.data?.did === 'string' && res.data.did.startsWith('did:')) return res.data.did
    else return null
}

async function unfurlPosts(ctx: any): Promise<LinkUnfurls> {
    const postLinks = ctx.payload.links.filter(x => x.url.match(bskyPostRegex));

    const atProtoPostLinks = await Promise.all(postLinks.map(async x => {
        const arr = x.url.split('/').filter((x) => !!x);
        const did = await resolveHandle(arr[3])
        return `at://${did}/app.bsky.feed.post/${arr[5]}`
    }))

    if (!atProtoPostLinks || atProtoPostLinks.filter(x => !!x).length == 0) return {}

    const posts = await bsky.getPosts({
        uris: atProtoPostLinks
    })

    let unfurls: LinkUnfurls = {}

    posts.data.posts.map((post) => {
        const url = `https://bsky.app/profile/${post.author.handle}/post/${post.uri.split('/').pop()}`;
        unfurls[url] = {
            color: "#0085ff",
            title_link: url,
            title: `${post.author.displayName} (${post.author.handle}) on Bluesky`,
            fallback: `${post.author.displayName} (${post.author.handle}) on Bluesky`,
            footer_icon: '',
            text: post.record.text,
            image_url: post.embed?.images?.[0].thumb,
            author_name: "Bluesky",
            author_link: "https://bsky.app/",
            author_icon: "https://bsky.app/static/favicon-32x32.png",
            thumb_url: post.author.avatar,
            ts: `${new Date(post.indexedAt).getTime() / 1000}`
        }
    })

    return unfurls
}

async function unfurlUsers(ctx: any): Promise<LinkUnfurls> {
    const userLinks = ctx.payload.links.filter(x => x.url.match(bskyUserRegex));

    const atProtoUserLinks = await Promise.all(userLinks.map(async x => {
        const arr = x.url.split('/').filter((x) => !!x);
        const did = await resolveHandle(arr[3])
        return did
    }))

    if (!atProtoUserLinks || atProtoUserLinks.filter(x => !!x).length == 0) return {}

    const users = await bsky.getProfiles({
        actors: atProtoUserLinks,
    })

    let unfurls: LinkUnfurls = {}

    users.data.profiles.map((profile) => {
        const url = `https://bsky.app/profile/${profile.handle}`;
        unfurls[url] = {
            color: "#0085ff",
            title_link: url,
            title: `${profile.displayName} (${profile.handle}) on Bluesky`,
            fallback: `${profile.displayName} (${profile.handle}) on Bluesky`,
            footer_icon: '',
            text: profile.description,
            image_url: profile.banner,
            author_name: "Bluesky",
            author_link: "https://bsky.app/",
            author_icon: "https://bsky.app/static/favicon-32x32.png",
            thumb_url: profile.avatar
        }
    })

    return unfurls
}

app.event("link_shared", async (ctx) => {
    const unfurls: LinkUnfurls = {
        ...(await unfurlPosts(ctx)),
        ...(await unfurlUsers(ctx)),
    };

    return ctx.client.chat.unfurl({
        channel: ctx.payload.channel,
        ts: ctx.payload.message_ts,
        unfurls
    })
})

function mrkdwnText(text: string, plain_text?: string) {
    return {
        text: plain_text,
        blocks: [
            {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text
                }
            }
        ]
    }
}

const commands: Record<
    string,
    (ctx: SlackCommandMiddlewareArgs & AllMiddlewareArgs<StringIndexed>, args: string[]) => Promise<void>
> = {
    async subscribe(ctx: SlackCommandMiddlewareArgs & AllMiddlewareArgs<StringIndexed>, args) {
        if (!args.length) return ctx.respond({
            response_type: 'ephemeral',
            text: "You need to provide a user handle to subscribe to!"
        })

        const handle = args[0];

        const did = await resolveHandle(handle);

        if (!did) return ctx.respond({
            response_type: 'ephemeral',
            ...mrkdwnText(`Hmmm... \`${handle}\` doesn't seem to exist. This might be a bug though, please report it!`, `Hmmm... ${handle} doesn't seem to exist. This might be a bug though, please report it!`)
        })

        const subscriptions = await sql<{
            did: string,
            channels: string[]
        }[]>`SELECT channels FROM subscriptions WHERE did = ${did};`

        if (subscriptions.length && subscriptions[0].channels.includes(ctx.body.channel_id)) {
            return ctx.respond({
                response_type: 'ephemeral',
                ...mrkdwnText(`You're already subscribed to *<https://bsky.app/profile/${handle}|${handle}>*. If they've changed their handle, it'll automatically update.`, `You're already subscribed to ${handle}. If they've changed their handle, it'll automatically update.`)
            })
        }

        if (subscriptions.length) {
            await sql`UPDATE subscriptions SET channels = channels || ARRAY[${ctx.body.channel_id}] WHERE did = ${did};`
        } else {
            await sql`INSERT INTO subscriptions VALUES (${did}, ${[ctx.body.channel_id]})`
            const { data } = await bsky.getAuthorFeed({
                actor: did,
                filter: 'posts_no_replies',
                limit: 1
            });
    
            if (data.feed.length) {
                await sql`INSERT INTO latest_posts VALUES (${did}, ${data.feed[0].post.uri});`
            } else {
                await sql`INSERT INTO latest_posts VALUES (${did}, ${"at://null"});`
            }
        }

        return ctx.respond({
            response_type: 'in_channel',
            ...mrkdwnText(`Successfully subscribed to *<https://bsky.app/profile/${handle}|${handle}>*!`, `Successfully subscribed to ${handle}!`),
            unfurl_links: true
        })
    },

    async unsubscribe(ctx: SlackCommandMiddlewareArgs & AllMiddlewareArgs<StringIndexed>, args) {
        if (!args.length) return ctx.respond({
            response_type: 'ephemeral',
            text: "You need to provide a user handle to unsubscribe from!"
        })

        const handle = args[0];

        const did = await resolveHandle(handle);

        if (!did) return ctx.respond({
            response_type: 'ephemeral',
            ...mrkdwnText(`Hmmm... \`${handle}\` doesn't seem to exist. This might be a bug though, please report it!`, `Hmmm... ${handle} doesn't seem to exist. This might be a bug though, please report it!`)
        })

        const subscriptions = await sql<{
            did: string,
            channels: string[]
        }[]>`SELECT channels FROM subscriptions WHERE did = ${did};`

        if (subscriptions.length && !subscriptions[0].channels.includes(ctx.body.channel_id)) {
            return ctx.respond({
                response_type: 'ephemeral',
                ...mrkdwnText(`You're aren't subscribed to *<https://bsky.app/profile/${handle}|${handle}>*.`, `You're aren't subscribed to ${handle}.`)
            })
        }

        await sql`UPDATE subscriptions SET channels = array_remove(channels, ${ctx.body.channel_id}) WHERE did = ${did};`

        return ctx.respond({
            response_type: 'in_channel',
            ...mrkdwnText(`Successfully unsubscribed from *<https://bsky.app/profile/${handle}|${handle}>*!`, `Successfully unsubscribed from ${handle}!`)
        })
    },

    async force_refresh(ctx, args) {
        if (!args.length) return ctx.respond({
            response_type: 'ephemeral',
            text: "You need to provide a user handle to unsubscribe from!"
        })

        const handle = args[0];

        const did = await resolveHandle(handle);

        if (!did) return ctx.respond({
            response_type: 'ephemeral',
            ...mrkdwnText(`Hmmm... \`${handle}\` doesn't seem to exist. This might be a bug though, please report it!`, `Hmmm... ${handle} doesn't seem to exist. This might be a bug though, please report it!`)
        })

        const posts = await sql<{
            did: string,
            post: string
        }[]>`SELECT post FROM latest_posts WHERE did = ${did};`

	if (!posts.length) {
	    return ctx.respond({
		response_type: 'ephemeral',
		...mrkdwnText(`I have no record of a *<https://bsky.app/profile/${handle}|${handle}>* in my database. Try subscribe them to a channel first.`, `I have no record of a ${handle} in my database. Try subscribe them to a channel first.`)
	    })
	}

            const { data } = await bsky.getAuthorFeed({
                actor: did,
                filter: 'posts_no_replies',
                limit: 1
            });

            if (data.feed.length) {
                await sql`INSERT INTO latest_posts VALUES (${did}, ${data.feed[0].post.uri});`
            } else {
                await sql`INSERT INTO latest_posts VALUES (${did}, ${"at://null"});`
            }

	const latest_post = (() => {
		if (data.feed.length) {
			const post = data.feed[0].post
			return `<https://bsky.app/profile/${post.author.handle}/post/${post.uri.split('/').pop()}>`;
		} else {
			return `This user has not made a post yet.`
		}
	})();

	return ctx.respond({
	    response_type: 'ephemeral',
	    ...mrkdwnText(`Refreshed *${handle}*'s post cache. Their latest post is *${latest_post}*.`, `Refreshed ${handle}'s post cache. Their latest post is ${latest_post}.`),
	    unfurl_links: true
	})
    },

    async help(ctx, args) {
        ctx.respond({
            response_type: 'ephemeral',
            text: "I can't be bothered to make a proper help command at the moment. /bluesky subscribe and /bluesky unsubscribe is all that exists at the moment."
        })
    },

    async post(ctx, args) {
        ctx.respond({
            response_type: 'ephemeral',
            text: "soon:tm:"
        })
    }
}

app.command("/bluesky", async (ctx) => {
    await ctx.ack();

    if (ctx.payload.text.trim() == "") {
        return commands.help(ctx, [])
    }

    const args = ctx.payload.text.trim().split(/ +/g);
    const command = args.shift();

    if (command!.toLowerCase() in commands) {
        return commands[command!.toLowerCase()](ctx, args)
    } else {
        return commands.help(ctx, args)
    }
})

function filterPosts(posts: PostView[], postId: string): PostView[] {
    if (postId == "at://null") return posts;

    // Find the index of the targetUUID (uuid4 in this case)
    const targetIndex = posts.findIndex((post) => post.uri == postId);

    // If the UUID is found, return the elements before it
    if (targetIndex !== -1) {
        return posts.slice(0, targetIndex); // Return all elements before the targetIndex
    }

    // If the UUID is not found, return an empty array or handle accordingly
    return [];
}

app.start(43647).then(() => {
    console.log("The sky is blue... oh hi!")

    async function pollPosts() {
        const subscriptions = await sql<{
            did: string,
            channels: string[]
        }[]>`SELECT * FROM subscriptions;`

        for (let subscription of subscriptions) {
            if (subscription.channels.length == 0) continue;
            const d = await bsky.getAuthorFeed({
                actor: subscription.did,
                filter: 'posts_no_replies'
            });

            const latest = await sql`SELECT post FROM latest_posts WHERE did = ${subscription.did};`

            const posts = d.data.feed.map(x => x.post);

            const filtered = filterPosts(posts, latest[0].post);

            if (filtered.length) {
                let latestPost = filtered[0];
                subscription.channels.forEach(chan => {
                    for (let post of filtered.reverse()) {
                        // Check for reposts
                        if (post.author.did !== subscription.did) continue;
                        const url = `https://bsky.app/profile/${post.author.handle}/post/${post.uri.split('/').pop()}`;
                        app.client.chat.postMessage({
                            channel: chan,
                            ...mrkdwnText(`New post from *${post.author.displayName || post.author.handle}*: ${url}`, `New post from ${post.author.displayName}: ${url}`),
                            unfurl_links: true,
                            username: `${post.author.displayName || post.author.handle} via Bluesky`,
                            icon_url: post.author.avatar
                        })
                    }
                })

                await sql`UPDATE latest_posts SET post = ${latestPost.uri} WHERE did = ${subscription.did};`
            }
        }
    }

    setInterval(pollPosts, 2 * 60 * 1000)
    pollPosts()
})

process.on('SIGINT', () => {
    app.stop();
    process.exit(1)
})
