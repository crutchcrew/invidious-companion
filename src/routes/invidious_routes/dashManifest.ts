import { Hono } from "hono";
import { FormatUtils, type Innertube } from "youtubei.js";
import {
    youtubePlayerParsing,
    youtubeVideoInfo,
} from "../../lib/helpers/youtubePlayerHandling.ts";
import { verifyRequest } from "../../lib/helpers/verifyRequest.ts";
import { HTTPException } from "hono/http-exception";
import { encryptQuery } from "../../lib/helpers/encryptQuery.ts";
import { validateVideoId } from "../../lib/helpers/validateVideoId.ts";
import { TOKEN_MINTER_NOT_READY_MESSAGE } from "../../constants.ts";

const PRIVATE_PARAM_NAMES = ["pot", "ip"];

type Actions = Innertube["actions"];

// YouTube.js probes the stream itself (HEAD ...&sq=0) to learn the segment
// count of live streams. It does so with the URL returned by our transformer,
// which in local mode is a relative /companion/videoplayback path that fetch()
// rejects. Map such URLs back to the original googlevideo URL for that probe.
function withLocalUrlResolver(
    actions: Actions,
    localToOriginal: Map<string, string>,
): Actions {
    const resolve = (input: unknown) => {
        if (typeof input !== "string") return input;
        for (const [local, original] of localToOriginal) {
            if (input.startsWith(local)) {
                return original + input.slice(local.length);
            }
        }
        return input;
    };

    return new Proxy(actions, {
        get(target, prop) {
            const value = Reflect.get(target, prop);
            if (prop !== "session") return value;
            return new Proxy(value, {
                get(session, sessionProp) {
                    const sessionValue = Reflect.get(session, sessionProp);
                    if (sessionProp !== "http") return sessionValue;
                    return new Proxy(sessionValue, {
                        get(http, httpProp) {
                            const httpValue = Reflect.get(http, httpProp);
                            if (httpProp !== "fetch_function") {
                                return httpValue;
                            }
                            return (input: unknown, init?: unknown) =>
                                httpValue(resolve(input), init);
                        },
                    });
                },
            });
        },
    });
}

const dashManifest = new Hono();

dashManifest.get("/:videoId", async (c) => {
    const { videoId } = c.req.param();
    const { check, local } = c.req.query();
    c.header("access-control-allow-origin", "*");

    const innertubeClient = c.get("innertubeClient");
    const config = c.get("config");
    const metrics = c.get("metrics");
    const tokenMinter = c.get("tokenMinter");

    // Check if tokenMinter is ready (only needed when PO token is enabled)
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

    if (config.server.verify_requests && check == undefined) {
        throw new HTTPException(400, {
            res: new Response("No check ID."),
        });
    } else if (config.server.verify_requests && check) {
        if (verifyRequest(check, videoId, config) === false) {
            throw new HTTPException(400, {
                res: new Response("ID incorrect."),
            });
        }
    }

    const youtubePlayerResponseJson = await youtubePlayerParsing({
        innertubeClient,
        videoId,
        config,
        tokenMinter: tokenMinter!,
        metrics,
    });
    const videoInfo = youtubeVideoInfo(
        innertubeClient,
        youtubePlayerResponseJson,
    );

    if (videoInfo.playability_status?.status !== "OK") {
        throw ("The video can't be played: " + videoId + " due to reason: " +
            videoInfo.playability_status?.reason);
    }

    c.header("content-type", "application/dash+xml");

    if (videoInfo.streaming_data) {
        // video.js only support MP4 not WEBM. Also keep out text/mp4 (live
        // captions): it carries an audio track id, which makes toDash treat
        // the real audio formats (that have none) as broken and drop them.
        videoInfo.streaming_data.adaptive_formats = videoInfo
            .streaming_data.adaptive_formats
            .filter((i) =>
                i.mime_type.startsWith("audio/mp4") ||
                i.mime_type.startsWith("video/mp4")
            );

        const player_response = videoInfo.page[0];
        // TODO: fix include storyboards in DASH manifest file
        //const storyboards = player_response.storyboards;
        const captions = player_response.captions?.caption_tracks;

        const videoDetails = videoInfo.page[0].video_details;
        // Live formats carry no index/init ranges, so YouTube.js only emits
        // them (and a valid duration) through its post-live-DVR code path.
        const useLiveSegmentInfo = videoDetails?.is_post_live_dvr ||
            videoDetails?.is_live;
        const localToOriginal = new Map<string, string>();

        const dashFile = await FormatUtils.toDash(
            videoInfo.streaming_data,
            useLiveSegmentInfo,
            (url: URL) => {
                const dashUrl = url;
                const queryParams = new URLSearchParams(dashUrl.search);
                // Can't create URL type without host part
                queryParams.set("host", dashUrl.host);

                if (local) {
                    if (config.networking.videoplayback.ump) {
                        queryParams.set("ump", "yes");
                    }
                    if (
                        config.server.encrypt_query_params
                    ) {
                        const privateParams = [...queryParams].filter(([key]) =>
                            PRIVATE_PARAM_NAMES.includes(key)
                        );
                        const encryptedParams = encryptQuery(
                            JSON.stringify(privateParams),
                            config,
                        );

                        for (const param of PRIVATE_PARAM_NAMES) {
                            queryParams.delete(param);
                        }

                        queryParams.set("enc", "true");
                        queryParams.set("data", encryptedParams);
                    }
                    const localUrl = config.server.base_path +
                        dashUrl.pathname + "?" + queryParams.toString();
                    localToOriginal.set(localUrl, dashUrl.toString());
                    return localUrl as unknown as URL;
                } else {
                    return dashUrl;
                }
            },
            undefined,
            videoInfo.cpn,
            undefined,
            withLocalUrlResolver(innertubeClient.actions, localToOriginal),
            undefined,
            captions,
            undefined,
        );
        return c.body(dashFile);
    }
});

export default dashManifest;
