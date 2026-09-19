import { Hono } from "hono";
import { youtubePlayerParsing } from "../../lib/helpers/youtubePlayerHandling.ts";
import { HTTPException } from "hono/http-exception";
import { validateVideoId } from "../../lib/helpers/validateVideoId.ts";
import { TOKEN_MINTER_NOT_READY_MESSAGE } from "../../constants.ts";

const player = new Hono();

player.post("/player", async (c) => {
    const jsonReq = await c.req.json();
    const innertubeClient = c.get("innertubeClient");
    const config = c.get("config");
    const metrics = c.get("metrics");
    const tokenMinter = c.get("tokenMinter");

    // Check if tokenMinter is ready (only needed when PO token is enabled)
    if (config.jobs.youtube_session.po_token_enabled && !tokenMinter) {
        return c.json({
            playabilityStatus: {
                status: "ERROR",
                reason: TOKEN_MINTER_NOT_READY_MESSAGE,
                errorScreen: {
                    playerErrorMessageRenderer: {
                        reason: {
                            simpleText: TOKEN_MINTER_NOT_READY_MESSAGE,
                        },
                        subreason: {
                            simpleText: TOKEN_MINTER_NOT_READY_MESSAGE,
                        },
                    },
                },
            },
        });
    }

    if (!jsonReq.videoId) {
        throw new HTTPException(400, {
            res: new Response("Missing video ID."),
        });
    }

    if (!validateVideoId(jsonReq.videoId)) {
        throw new HTTPException(400, {
            res: new Response("Invalid video ID format."),
        });
    }

    const playerResponse = (await youtubePlayerParsing({
        innertubeClient,
        videoId: jsonReq.videoId,
        config,
        tokenMinter: tokenMinter!,
        metrics,
    })) as {
        videoDetails?: { isLive?: boolean };
        streamingData?: { hlsManifestUrl?: string };
    };

    // Live stream segment URLs expire ~30s after the response that issued
    // them, so YouTube's HLS manifest is unusable on its own: point the
    // client at our live HLS route, which keeps re-issuing them.
    if (
        playerResponse.videoDetails?.isLive &&
        playerResponse.streamingData?.hlsManifestUrl
    ) {
        return c.json({
            ...playerResponse,
            streamingData: {
                ...playerResponse.streamingData,
                hlsManifestUrl:
                    `${config.server.base_path}/api/manifest/hls/id/${jsonReq.videoId}`,
            },
        });
    }

    return c.json(playerResponse);
});

export default player;
