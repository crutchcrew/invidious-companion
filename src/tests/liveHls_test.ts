import { assertEquals } from "./deps.ts";
import { Hono } from "hono";
import liveHls from "../routes/invidious_routes/liveHls.ts";
import { parseConfig } from "../lib/helpers/config.ts";
import type { HonoVariables } from "../lib/types/HonoVariables.ts";

Deno.env.set("SERVER_SECRET_KEY", "aaaaaaaaaaaaaaaa");
const config = await parseConfig();
// The schema bakes some env vars in as defaults at module-load time, so
// re-setting them here wouldn't apply: mutate the parsed config instead.
config.server.verify_requests = true;
config.jobs.youtube_session.po_token_enabled = false;

function testApp() {
    const app = new Hono<{ Variables: HonoVariables }>();
    app.use("*", async (c, next) => {
        c.set("config", config);
        c.set("tokenMinter", undefined);
        c.set("innertubeClient", undefined as never);
        c.set("metrics", undefined);
        await next();
    });
    app.route("/", liveHls);
    return app;
}

const VIDEO_ID = "jNQXAC9IVRw";

Deno.test("liveHls enforces verify_requests like the sibling manifest routes", async (t) => {
    await t.step("master playlist: rejects a missing check", async () => {
        const res = await testApp().request(`/${VIDEO_ID}`);
        assertEquals(res.status, 400);
        await res.body?.cancel();
    });

    await t.step("master playlist: rejects an incorrect check", async () => {
        const res = await testApp().request(
            `/${VIDEO_ID}?check=not-a-real-check`,
        );
        assertEquals(res.status, 400);
        await res.body?.cancel();
    });

    await t.step("master playlist: rejects an invalid video ID", async () => {
        const res = await testApp().request(`/not-a-valid-id`);
        assertEquals(res.status, 400);
        await res.body?.cancel();
    });

    await t.step("variant playlist: rejects a missing check", async () => {
        const res = await testApp().request(`/${VIDEO_ID}/variant/140`);
        assertEquals(res.status, 400);
        await res.body?.cancel();
    });

    await t.step("segment: rejects a missing check", async () => {
        const res = await testApp().request(`/${VIDEO_ID}/segment/140/0`);
        assertEquals(res.status, 400);
        await res.body?.cancel();
    });
});
