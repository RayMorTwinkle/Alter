import { definePlugin, jsonItems } from "@alter/plugin-sdk";

const mapping = {
  url: "https://hn.algolia.com/api/v1/search?tags=front_page",
  itemsPath: "hits", idField: "objectID", titleField: "title", urlField: "url",
};
export default definePlugin({
  sources: {
    async json(ctx) {
      const response = await ctx.http.request({ method: "GET", url: mapping.url });
      if (response.status !== 200) throw new Error("JSON request failed");
      return jsonItems(JSON.parse(response.body), mapping);
    }
  }
});
