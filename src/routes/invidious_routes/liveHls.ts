import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { youtubePlayerParsing } from "../../lib/helpers/youtubePlayerHandling.ts";
import { validateVideoId } from "../../lib/helpers/validateVideoId.ts";
import { verifyRequest } from "../../lib/helpers/verifyRequest.ts";
import { TOKEN_MINTER_NOT_READY_MESSAGE } from "../../constants.ts";
import type { Config } from "../../lib/helpers/config.ts";

let getFetchClientLocation = "getFetchClient";
if (Deno.env.get("GET_FETCH_CLIENT_LOCATION")) {
    if (Deno.env.has("DENO_COMPILED")) {
        getFetchClientLocation = Deno.mainModule.replace("src/main.ts", "") +
            Deno.env.get("GET_FETCH_CLIENT_LOCATION");
    } else {
        getFetchClientLocation = Deno.env.get(
            "GET_FETCH_CLIENT_LOCATION",
        ) as string;
    }
}
const { getFetchClient } = await import(getFetchClientLocation);

// Live stream segment URLs stop working about 30 seconds after the player
// response (session) that issued them, so a static manifest can only play for
// half a minute. This route serves a live HLS stream that is continuously
// re-issued: playlists and segments are always resolved against a session that
// is at most SESSION_MAX_AGE_MS old, and segment URLs handed to the player are
// short companion URLs that are only resolved to a YouTube URL when fetched.
const SESSION_MAX_AGE_MS = 10_000;

// YouTube's live playlist holds the whole DVR window (hours), and players start
// at the beginning of what they are given. Serve a normal live sliding window
// instead, so playback starts at most this many segments behind the live edge.
const LIVE_WINDOW_SEGMENTS = 12;

const UPSTREAM_HEADERS = {
    "origin": "https://www.youtube.com",
    "referer": "https://www.youtube.com/",
    "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
};

type Playlist = {
    text: string;
    // sequence number -> upstream segment URL
    segments: Map<number, string>;
};

type LiveSession = {
    master: string;
    // itag -> upstream variant playlist URL
    variants: Map<string, string>;
    // itag -> variant playlist fetched with this session
    playlists: Map<string, Promise<Playlist>>;
};

type Deps = {
    innertubeClient: Parameters<typeof youtubePlayerParsing>[0]["innertubeClient"];
    config: Config;
    tokenMinter: Parameters<typeof youtubePlayerParsing>[0]["tokenMinter"];
    metrics: Parameters<typeof youtubePlayerParsing>[0]["metrics"];
};

const sessions = new Map<
    string,
    { startedAt: number; session: Promise<LiveSession> }
>();

const itagOf = (url: string) =>
    /\/itag\/(\d+)\//.exec(url)?.[1] ??
        new URL(url).searchParams.get("itag") ?? undefined;

const sqOf = (url: string) => {
    const sq = /\/sq\/(\d+)\//.exec(url)?.[1] ??
        new URL(url).searchParams.get("sq");
    return sq === null || sq === undefined ? undefined : Number(sq);
};

const isUrlLine = (line: string) => line.startsWith("http");

// Propagates the caller's check token to the companion URLs handed back to
// the player, so verify_requests also covers the variant/segment requests.
const withCheck = (url: string, check: string | undefined) =>
    check ? `${url}?check=${encodeURIComponent(check)}` : url;

async function upstreamFetch(config: Config, url: string) {
    const fetchClient = await getFetchClient(config);
    return await fetchClient(url, { headers: UPSTREAM_HEADERS });
}

async function fetchPlaylistText(config: Config, url: string) {
    const res = await upstreamFetch(config, url);
    if (!res.ok) {
        await res.body?.cancel();
        throw new HTTPException(502, {
            res: new Response(`YouTube returned ${res.status} for a playlist.`),
        });
    }
    return await res.text();
}

async function createSession(
    { innertubeClient, config, tokenMinter, metrics }: Deps,
    videoId: string,
): Promise<LiveSession> {
    const info = await youtubePlayerParsing({
        innertubeClient,
        videoId,
        config,
        tokenMinter: tokenMinter!,
        metrics,
        // Always a new session, the cached one is likely expired
        overrideCache: true,
    }) as { streamingData?: { hlsManifestUrl?: string } };

    const hlsManifestUrl = info.streamingData?.hlsManifestUrl;
    if (!hlsManifestUrl) {
        throw new HTTPException(404, {
            res: new Response("No HLS manifest available for this video."),
        });
    }

    const master = await fetchPlaylistText(config, hlsManifestUrl);
    const variants = new Map<string, string>();
    for (const line of master.split("\n")) {
        if (!isUrlLine(line)) continue;
        const itag = itagOf(line.trim());
        if (itag) variants.set(itag, line.trim());
    }

    return { master, variants, playlists: new Map() };
}

function getSession(deps: Deps, videoId: string, forceNew = false) {
    const now = Date.now();
    for (const [id, entry] of sessions) {
        if (now - entry.startedAt > 60_000) sessions.delete(id);
    }

    const cached = sessions.get(videoId);
    if (cached && !forceNew && now - cached.startedAt < SESSION_MAX_AGE_MS) {
        return cached.session;
    }

    const entry = {
        startedAt: now,
        session: createSession(deps, videoId),
    };
    sessions.set(videoId, entry);
    // Don't keep failed sessions around
    entry.session.catch(() => {
        if (sessions.get(videoId) === entry) sessions.delete(videoId);
    });
    return entry.session;
}

function getPlaylist(
    { config }: Deps,
    session: LiveSession,
    itag: string,
): Promise<Playlist> {
    let playlist = session.playlists.get(itag);
    if (!playlist) {
        const url = session.variants.get(itag);
        if (!url) {
            throw new HTTPException(404, {
                res: new Response("Unknown variant."),
            });
        }
        playlist = fetchPlaylistText(config, url).then((text) => {
            const segments = new Map<number, string>();
            for (const line of text.split("\n")) {
                if (!isUrlLine(line)) continue;
                const sq = sqOf(line.trim());
                if (sq !== undefined) segments.set(sq, line.trim());
            }
            return { text, segments };
        });
        session.playlists.set(itag, playlist);
        playlist.catch(() => session.playlists.delete(itag));
    }
    return playlist;
}

// Keep only the last `keep` segments of a media playlist, moving the
// media/discontinuity sequence numbers along with the dropped segments.
function trimToLiveWindow(lines: string[], keep: number): string[] {
    const urls = lines.flatMap((line, i) =>
        line && !line.startsWith("#") ? [i] : []
    );
    if (urls.length <= keep) return lines;

    const firstExtinf = lines.findIndex((line) => line.startsWith("#EXTINF"));
    // Not a well-formed media playlist: leave it untouched rather than guess.
    if (firstExtinf === -1) return lines;

    const dropped = urls.length - keep;
    // First line of the first segment we keep (segments start after the
    // previous segment's URL line)
    const cut = urls[dropped - 1] + 1;
    const discontinuities =
        lines.slice(0, cut).filter((line) => line === "#EXT-X-DISCONTINUITY")
            .length;

    let hasMediaSequence = false;
    let hasDiscontinuitySequence = false;
    const header = lines
        .slice(0, firstExtinf)
        // These belong to the first segment, which is dropped
        .filter((line) =>
            !line.startsWith("#EXT-X-PROGRAM-DATE-TIME") &&
            line !== "#EXT-X-DISCONTINUITY"
        )
        .map((line) => {
            const media = /^#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(line);
            if (media) {
                hasMediaSequence = true;
                return `#EXT-X-MEDIA-SEQUENCE:${Number(media[1]) + dropped}`;
            }
            const disc = /^#EXT-X-DISCONTINUITY-SEQUENCE:(\d+)/.exec(line);
            if (disc) {
                hasDiscontinuitySequence = true;
                return `#EXT-X-DISCONTINUITY-SEQUENCE:${
                    Number(disc[1]) + discontinuities
                }`;
            }
            return line;
        });
    if (!hasMediaSequence) header.push(`#EXT-X-MEDIA-SEQUENCE:${dropped}`);
    if (!hasDiscontinuitySequence && discontinuities > 0) {
        header.push(`#EXT-X-DISCONTINUITY-SEQUENCE:${discontinuities}`);
    }

    return [...header, ...lines.slice(cut)];
}

const playlistHeaders = {
    "content-type": "application/x-mpegURL",
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
};

const liveHls = new Hono();

function depsFor(
    c: {
        get: (key: string) => unknown;
        req: { query: (key: string) => string | undefined };
    },
    videoId: string,
): Deps {
    const config = c.get("config") as Config;
    const tokenMinter = c.get("tokenMinter") as Deps["tokenMinter"];

    if (config.jobs.youtube_session.po_token_enabled && !tokenMinter) {
        throw new HTTPException(503, {
            res: new Response(TOKEN_MINTER_NOT_READY_MESSAGE),
        });
    }
    if (!validateVideoId(videoId)) {
        throw new HTTPException(400, {
            res: new Response("Invalid video ID format."),
        });
    }

    const check = c.req.query("check");
    if (config.server.verify_requests && check == undefined) {
        throw new HTTPException(400, {
            res: new Response("No check ID."),
        });
			}

    if (config.server.verify_requests && check && verifyRequest(check, videoId, config) === false) {
				throw new HTTPException(400, {
						res: new Response("ID incorrect."),
				});
    }

    return {
        innertubeClient: c.get("innertubeClient") as Deps["innertubeClient"],
        config,
        tokenMinter,
        metrics: c.get("metrics") as Deps["metrics"],
    };
}

// Master playlist
liveHls.get("/:videoId", async (c) => {
    const { videoId } = c.req.param();
    const check = c.req.query("check");
    const deps = depsFor(c, videoId);
    const base = `${deps.config.server.base_path}/api/manifest/hls/id/${videoId}`;

    const session = await getSession(deps, videoId);
    const body = session.master.replace(/https:\/\/[^\s"]+/g, (url) => {
        const itag = itagOf(url);
        return itag ? withCheck(`${base}/variant/${itag}`, check) : url;
    });

    return c.body(body, 200, playlistHeaders);
});

// Variant (media) playlist, segment URLs point back to this route
liveHls.get("/:videoId/variant/:itag", async (c) => {
    const { videoId, itag } = c.req.param();
    const check = c.req.query("check");
    const deps = depsFor(c, videoId);
    const base = `${deps.config.server.base_path}/api/manifest/hls/id/${videoId}`;

    const session = await getSession(deps, videoId);
    const playlist = await getPlaylist(deps, session, itag);
    const rewritten = playlist.text.split("\n").map((line) => {
        if (!isUrlLine(line)) return line;
        const sq = sqOf(line.trim());
        return sq === undefined
            ? line
            : withCheck(`${base}/segment/${itag}/${sq}`, check);
    });
    const body = trimToLiveWindow(rewritten, LIVE_WINDOW_SEGMENTS).join("\n");

    return c.body(body, 200, playlistHeaders);
});

// Segment: resolved against a fresh session, retried once with a new one
liveHls.get("/:videoId/segment/:itag/:sq", async (c) => {
    const { videoId, itag, sq } = c.req.param();
    const deps = depsFor(c, videoId);

    for (const forceNew of [false, true]) {
        const session = await getSession(deps, videoId, forceNew);
        const playlist = await getPlaylist(deps, session, itag);
        const url = playlist.segments.get(Number(sq));
        if (!url) continue;

        const upstream = await upstreamFetch(deps.config, url);
        if (upstream.status === 403 && !forceNew) {
            await upstream.body?.cancel();
            continue;
        }

        return new Response(upstream.body, {
            status: upstream.status,
            headers: {
                "content-type": upstream.headers.get("content-type") ||
                    "video/mp2t",
                "access-control-allow-origin": "*",
                "cache-control": "no-store",
            },
        });
    }

    throw new HTTPException(404, {
        res: new Response("Segment not found in the live playlist."),
    });
});

export default liveHls;
