import { definePlugin, githubItems } from "@alter/plugin-sdk";

export default definePlugin({
  sources: {
    async github(ctx) {
      const response = await ctx.http.request({
        method: "GET", url: "https://api.github.com/notifications",
        headers: { Accept: "application/vnd.github+json", "User-Agent": "Alter" },
        secretHeaders: { Authorization: "Bearer ${secret:token}" }
      });
      if (response.status !== 200) throw new Error("GitHub request failed");
      return githubItems(JSON.parse(response.body));
    }
  }
});
