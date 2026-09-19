import { ApiResponse, Innertube } from "youtubei.js";
import NavigationEndpoint from "youtubei.js/NavigationEndpoint";
import type { TokenMinter } from "../jobs/potoken.ts";

import type { Config } from "./config.ts";

function callWatchEndpoint(
    videoId: string,
    innertubeClient: Innertube,
    innertubeClientType: string,
    contentPoToken?: string | undefined,
) {
    const watch_endpoint = new NavigationEndpoint({
        watchEndpoint: {
            videoId: videoId,
            // Allow companion to gather sensitive content videos like
            // `VuSU7PcEKpU`
            racyCheckOk: true,
            contentCheckOk: true,
        },
    });

    return watch_endpoint.call(innertubeClient.actions, {
        playbackContext: {
            contentPlaybackContext: {
                vis: 0,
                splay: false,
                lactMilliseconds: "-1",
                signatureTimestamp: innertubeClient.session.player
                    ?.signature_timestamp,
            },
        },
        ...(typeof contentPoToken === "string" && {
            serviceIntegrityDimensions: {
                poToken: contentPoToken,
            },
        }),
        client: innertubeClientType,
    });
}

export const youtubePlayerReq = async (
    innertubeClient: Innertube,
    videoId: string,
    config: Config,
    tokenMinter: TokenMinter,
): Promise<ApiResponse> => {
    const innertubeClientOauthEnabled = config.youtube_session.oauth_enabled;

    let innertubeClientUsed = "WEB";
    if (innertubeClientOauthEnabled) {
        innertubeClientUsed = "TV";
    }

    const contentPoToken = await tokenMinter(videoId);

    const youtubePlayerResponse = await callWatchEndpoint(
        videoId,
        innertubeClient,
        innertubeClientUsed,
        contentPoToken,
    );

    // Live streams: the WEB client only hands out SABR-gated segment URLs
    // (every `sq=N` request 403s) and only sometimes an HLS manifest.
    // ANDROID_VR returns an HLS manifest and plain segment URLs that work
    // without a PO token, so take the streaming data from it instead.
    if (
        youtubePlayerResponse.data.videoDetails?.isLive &&
        youtubePlayerResponse.data.streamingData
    ) {
        try {
            const liveResponse = await callWatchEndpoint(
                videoId,
                innertubeClient,
                "ANDROID_VR",
                // The WEB content PO token is bound to the WEB client:
                // sending it makes the returned segment URLs 403.
            );
            const liveStreamingData = liveResponse.data.streamingData;
            if (liveStreamingData?.adaptiveFormats?.[0]?.url) {
                youtubePlayerResponse.data.streamingData = liveStreamingData;
                // Callers detect the client from the response context to
                // decide about deciphering: ANDROID URLs must be left alone
                // (deciphering appends the session PO token, which 403s).
                youtubePlayerResponse.data.responseContext =
                    liveResponse.data.responseContext;
            } else {
                console.log(
                    "[WARNING] ANDROID_VR returned no usable live streaming data, keeping the WEB client response.",
                );
            }
        } catch (err) {
            console.log(
                "[WARNING] Failed to get live streaming data from ANDROID_VR, keeping the WEB client response.",
                err,
            );
        }
    }

    // Check if the first adaptive format URL is undefined, if it is then fallback to multiple YT clients

    if (
        !innertubeClientOauthEnabled &&
        youtubePlayerResponse.data.streamingData &&
        youtubePlayerResponse.data.streamingData.adaptiveFormats[0].url ===
            undefined
    ) {
        console.log(
            "[WARNING] No URLs found for adaptive formats. Falling back to other YT clients.",
        );
        const innertubeClientsTypeFallback = [
            "TV_SIMPLY",
            "ANDROID_VR",
            "MWEB",
        ];

        for await (const innertubeClientType of innertubeClientsTypeFallback) {
            console.log(
                `[WARNING] Trying fallback YT client ${innertubeClientType}`,
            );
            const youtubePlayerResponseFallback = await callWatchEndpoint(
                videoId,
                innertubeClient,
                innertubeClientType,
                contentPoToken,
            );
            if (
                youtubePlayerResponseFallback.data.streamingData && (
                    youtubePlayerResponseFallback.data.streamingData
                        .adaptiveFormats[0].url ||
                    youtubePlayerResponseFallback.data.streamingData
                        .adaptiveFormats[0].signatureCipher
                )
            ) {
                const fallbackFormats =
                    youtubePlayerResponseFallback.data.streamingData.formats;
                if (fallbackFormats?.length) {
                    youtubePlayerResponse.data.streamingData.formats =
                        fallbackFormats;
                }
                youtubePlayerResponse.data.streamingData.adaptiveFormats =
                    youtubePlayerResponseFallback.data.streamingData
                        .adaptiveFormats;
                break;
            }
        }
    }

    return youtubePlayerResponse;
};
