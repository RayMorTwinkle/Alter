import { definePlugin, parseFeed } from "@alter/plugin-sdk";

export default definePlugin({
  sources: {
    async rss(ctx) {
      const url = "https://hnrss.org/frontpage";
      const response = await ctx.http.request({ method: "GET", url });
      if (response.status !== 200) throw new Error("RSS request failed");
      return parseFeed(response.body, url);
    }
  }
});
