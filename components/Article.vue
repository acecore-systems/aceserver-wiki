<template>
  <article class="Article">
    <h1 class="Article_Title">{{ article.title }}</h1>
    <!-- eslint-disable-next-line vue/no-v-html -->
    <div class="Article_Body" v-html="article.body"></div>
  </article>
</template>

<script>
export default {
  props: {
    article: {
      type: Object,
      default: () => ({
        title: '',
        body: '',
      }),
    },
  },
}
</script>

<style scoped>
.Article {
  padding: 108px 24px 52px 24px;
  flex: 1;
  min-width: 0;
}
.Article_Title {
  margin: -6px 0 24px 0;
  padding: 0px 0px 0px 10px;
  font-size: 2.8rem;
  border-top:#000 solid;
  border-bottom:#000 solid;
  background: #f0f0f0;
}
.Article_Body >>> h1,
.Article_Body >>> h2,
.Article_Body >>> h3,
.Article_Body >>> h4,
.Article_Body >>> h5,
.Article_Body >>> h6 {
  padding: 0;
  margin: 40px 0 24px 0;
  line-height: 1.4;
}
.Article_Body >>> h1 {
  font-size: 2.4rem;
  border-left: 6px double #000;
  background: #f0f0f0;
  padding:0px 0px 0px 10px;
  margin-bottom:0.2em;
}
.Article_Body >>> h2 {
  font-size: 2.2rem;
  border-bottom:3px double #000;
  background: #f0f0f0;
  margin-bottom:0.2em;
}
.Article_Body >>> h3 {
  font-size: 2rem;
  border-bottom:#000 solid 2px;
  background:#f0f0f0;
  margin-bottom:0.2em;
}
.Article_Body >>> h4 {
  font-size: 2.2rem;
  counter-increment:h2list;
  border-bottom:3px double #000;
  background: #f0f0f0;
  list-style: none;
  margin-bottom:0.2em;
}
.Article_Body >>> h4::before {
  content:counter(h2list)",";
}
.Article_Body >>> h5 {
  font-size: 2.2rem;
  border-bottom:3px double #000;
  background: #f0f0f0;
  padding-left:1.3em;
  margin-bottom:0.2em;
}
.Article_Body >>> h5::before {
  content:"・"
}
.Article_Body >>> h6 {
  font-size: 1.4rem;
  font-weight:normal;
  padding-left:3.0em;
  line-height: 1em;
  margin-top: 1.5em;
  margin-bottom: 1.1em;
}
.Article_Body >>> h2 a {
  color: #333;
  text-decoration: none;
}
.Article_Body >>> h2 a img {
  margin: 0 0 -2px 4px;
  opacity: 0;
  left: 100%;
  display: inline;
}
.Article_Body >>> h2 a:hover {
  border-bottom: 1px solid #333;
}
.Article_Body >>> h2 a:hover img {
  opacity: 1;
}
.Article_Body >>> p {
  margin: 0 0 24px 0;
}
.Article_Body >>> img {
  max-width: 100%;
  height: auto;
  margin: 5px auto;
  margin-left: 0%;
  display: block;
}
.Article_Body >>> ul,
.Article_Body >>> ol {
  margin: 0;
  padding: 0 0 0 40px;
}
.Article_Body >>> ul li,
.Article_Body >>> ol li {
  margin: 0 0 4px 0;
  padding: 0;
}
.Article_Body >>> ul li ul,
.Article_Body >>> ul li ol,
.Article_Body >>> ol li ol,
.Article_Body >>> ol li ul {
  padding: 0 0 0 20px;
}
.Article_Body >>> blockquote {
  border-left: 4px solid #ccc;
  padding: 0 0 0 40px;
  margin: 0 0 20px 0;
}
.Article_Body >>> pre {
  background: #333;
  color: #fff;
  border-radius: 4px;
  padding: 16px 20px;
  margin: 0 0 20px 0;
  font-size: 1.4rem;
  line-height: 1.6;
  overflow: auto;
  font-family: 'Segoe UI Emoji', 'Helvetica Neue', Arial,
    'Hiragino Kaku Gothic ProN', 'Hiragino Sans', Meiryo, sans-serif;
}
.Article_Body >>> code {
  border: 1px solid #ddd;
  background: #f8f8f8;
  border-radius: 4px;
  padding: 2px 4px;
  margin: 0 4px;
  color: #e01d5a;
  font-size: 1.4rem;
  font-family: 'Segoe UI Emoji', 'Helvetica Neue', Arial,
    'Hiragino Kaku Gothic ProN', 'Hiragino Sans', Meiryo, sans-serif;
}
.Article_Body >>> pre code {
  border: none;
  background: none;
  border-radius: 0;
  padding: 0;
  margin: 0;
  color: #fff;
}
.Article_Body >>> table {
  width:100%;
  vertical-align:middle;
  border-collapse:collapse;
  white-space:nowrap;
  overflow-x:scroll;
}
.Article_Body >>> table th {
  border:2px solid #eee;
  padding:4px 8px;
  background-color: #f0f0f0;
}
.Article_Body >>> table td {
  border:2px solid #eee;
  padding:4px 8px;
}
@media (min-width: 600px) {
  .Article {
    padding: 60px 0 52px 0;
  }
}
</style>
