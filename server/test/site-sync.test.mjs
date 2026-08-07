import test from "node:test";
import assert from "node:assert";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Point sync at a temp inventory file so tests never touch the real one.
process.env.INVENTORY_FILE = path.join(os.tmpdir(), "cd-sync-test-inventory.json");
try { fs.unlinkSync(process.env.INVENTORY_FILE); } catch {}

const { syncConfig, searchUrl, fetchAllDiamonds, parseDiamondDetail, mapDiamond, syncSite, getInventory, getSyncStatus, loadInventoryFromDisk } =
  await import("../site-sync.js");

const SEARCH_HTML = [
  { ProdId: "8171", ProdName: "1.06 carat, Fancy Deep Brownish Greenish Yellow, Oval Shape, SI1 Clarity, GIA", OldPrice: 3657, NewPrice: 3657, ImgPath: "/Product/Diamond/8171/still.jpg" },
  { ProdId: "8035", ProdName: "0.71 carat, , Asscher Shape, NC", OldPrice: 0, NewPrice: 0, ImgPath: "/assets/img/ColorDiam.png" },
  { ProdId: "8398", ProdName: "1.07 carat, Faint  Pink, Round Shape, VS2 Clarity, GIA", OldPrice: 7998, NewPrice: 7998, ImgPath: "/Product/Diamond/8398/still.jpg" },
];

function fakeDetail(id) {
  const byId = {
    "8171": `<!doctype html><html><body>
      <meta property="og:title" content="1.06 carat, Fancy Deep Brownish Greenish Yellow, Oval Shape, SI1 Clarity, GIA | ColourDiam" />
      <h3 class="product-name product-name2">1.06 carat, Fancy Deep Brownish Greenish Yellow, Oval Shape, SI1 Clarity, GIA</h3>
      <div class="price-box"><span class="price-regular">$3657</span></div>
      <div id='imgSlider' class='lightSlider masonry-container'>
        <div class="post-portfolio pro-large-img img-zoom" data-thumb="/Product/Diamond/8171/bA1.jpg"></div>
        <div class="post-portfolio pro-large-img img-zoom" data-thumb="/Product/Diamond/8171/still.jpg"></div>
      </div>
      <div class="cert"><img src="/assets/img/Lab/GIA.png" /></div>
      <a onclick="CertModal('/Product/Certificate/8171.pdf')"></a>
      <table class="table border"><tbody class="table-body">
        <tr><th>Shape</th><th>Carat</th><th>Color</th><th>Clarity</th></tr>
        <tr><td>Oval</td><td>1.06</td><td>Fancy Deep Brownish Greenish Yellow</td><td>SI1</td></tr>
        <tr><th>Measurement</th><th>Depth%</th><th>Table%</th><th>Ratio</th></tr>
        <tr><td>7.51 x 5.12 x 3.37</td><td>65.70</td><td>54.00</td><td>1.47</td></tr>
        <tr><th>Fluorescence</th><th>Polish</th><th>Symmetry</th><th></th></tr>
        <tr><td>STG</td><td>EX</td><td>VG</td><td></td></tr>
      </tbody></table>
    </body></html>`,
    "8035": `<!doctype html><html><body>
      <meta property="og:title" content="0.71 carat, , Asscher Shape, NC | ColourDiam" />
      <h3 class="product-name product-name2">0.71 carat, , Asscher Shape, NC</h3>
      <div class="price-box"><span><a href="javascript:void(0);">Contact For Price</a></span></div>
      <table class="table border"><tbody class="table-body">
        <tr><th>Shape</th><th>Carat</th><th>Color</th><th>Clarity</th></tr>
        <tr><td>Asscher</td><td>0.71</td><td></td><td></td></tr>
        <tr><th>Measurement</th><th>Depth%</th><th>Table%</th><th>Ratio</th></tr>
        <tr><td></td><td></td><td></td><td></td></tr>
        <tr><th>Fluorescence</th><th>Polish</th><th>Symmetry</th><th></th></tr>
        <tr><td></td><td></td><td></td><td></td></tr>
      </tbody></table>
    </body></html>`,
    "8398": `<!doctype html><html><body>
      <meta property="og:title" content="1.07 carat, Faint  Pink, Round Shape, VS2 Clarity, GIA | ColourDiam" />
      <h3 class="product-name product-name2">1.07 carat, Faint  Pink, Round Shape, VS2 Clarity, GIA</h3>
      <div class="price-box"><span class="price-regular">$7,998</span></div>
      <table class="table border"><tbody class="table-body">
        <tr><th>Shape</th><th>Carat</th><th>Color</th><th>Clarity</th></tr>
        <tr><td>Round</td><td>1.07</td><td>Faint Pink</td><td>VS2</td></tr>
        <tr><th>Measurement</th><th>Depth%</th><th>Table%</th><th>Ratio</th></tr>
        <tr><td>6.80 x 6.83 x 4.20</td><td>61.60</td><td>58.00</td><td>1.00</td></tr>
        <tr><th>Fluorescence</th><th>Polish</th><th>Symmetry</th><th></th></tr>
        <tr><td>NON</td><td>EX</td><td>EX</td><td></td></tr>
      </tbody></table>
    </body></html>`,
  };
  return byId[id] || "<html><body>not found</body></html>";
}

function mockSite() {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/Home/SearchDiamonds")) {
      const page = Number(new URL(u).searchParams.get("PageIndex")) || 1;
      return new Response(JSON.stringify({
        SearchProductsList: SEARCH_HTML,
        TotalCount: SEARCH_HTML.length,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (u.includes("/diamonddetails/")) {
      const id = decodeURIComponent(u).split("/").pop();
      return new Response(fakeDetail(id), { status: 200, headers: { "Content-Type": "text/html" } });
    }
    return new Response("not found", { status: 404 });
  };
  return () => { globalThis.fetch = original; };
}

test("searchUrl builds the diamonds search endpoint", () => {
  const u = new URL(searchUrl(3, 100));
  assert.equal(u.pathname, "/Home/SearchDiamonds");
  assert.equal(u.searchParams.get("PageIndex"), "3");
  assert.equal(u.searchParams.get("PageCount"), "100");
});

test("fetchAllDiamonds returns the site list", async () => {
  const restore = mockSite();
  try {
    const { list, total } = await fetchAllDiamonds();
    assert.equal(list.length, SEARCH_HTML.length);
    assert.equal(total, SEARCH_HTML.length);
    assert.equal(list[0].ProdId, "8171");
  } finally {
    restore();
  }
});

test("parseDiamondDetail extracts the full spec table", () => {
  const d = parseDiamondDetail(fakeDetail("8171"));
  assert.equal(d.name, "1.06 carat, Fancy Deep Brownish Greenish Yellow, Oval Shape, SI1 Clarity, GIA");
  assert.equal(d.shape, "Oval");
  assert.equal(d.carat, "1.06");
  assert.equal(d.colorGrade, "Fancy Deep Brownish Greenish Yellow");
  assert.equal(d.clarity, "SI1");
  assert.equal(d.measurement, "7.51 x 5.12 x 3.37");
  assert.equal(d.depth, "65.70");
  assert.equal(d.tablePct, "54.00");
  assert.equal(d.ratio, "1.47");
  assert.equal(d.fluorescence, "STG");
  assert.equal(d.polish, "EX");
  assert.equal(d.symmetry, "VG");
  assert.equal(d.lab, "GIA");
  assert.equal(d.certificate, "/Product/Certificate/8171.pdf");
  assert.ok(d.images.includes("/Product/Diamond/8171/bA1.jpg"));
  assert.equal(d.price, 3657);
});

test("parseDiamondDetail handles sparse diamonds", () => {
  const d = parseDiamondDetail(fakeDetail("8035"));
  assert.equal(d.shape, "Asscher");
  assert.equal(d.clarity, "");
  assert.equal(d.price, 0);
  assert.deepEqual(d.images, []);
});

test("mapDiamond maps to the app Diamond model with HTTPS media URLs", () => {
  const detail = parseDiamondDetail(fakeDetail("8171"));
  const mapped = mapDiamond(SEARCH_HTML[0], detail);
  assert.equal(mapped.id, "8171");
  assert.equal(mapped.category, "Oval");
  assert.equal(mapped.carat, "1.06");
  assert.equal(mapped.price, 3657);
  assert.equal(mapped.stock, "In stock");
  assert.equal(mapped.clarity, "SI1");
  assert.equal(mapped.lab, "GIA");
  assert.match(mapped.img, /^https:\/\/www\.colourdiam\.com\/Product\/Diamond\/8171\/bA1\.jpg$/);
  assert.ok(mapped.images.every((i) => /^https:\/\//.test(i)));
  assert.equal(mapped.certificate, "https://www.colourdiam.com/Product/Certificate/8171.pdf");
  assert.match(mapped.detailUrl, /^https:\/\/www\.colourdiam\.com\/diamonddetails\/Menu Diamonds\/8171$/);
});

test("mapDiamond falls back gracefully for placeholder-only diamonds", () => {
  const detail = parseDiamondDetail(fakeDetail("8035"));
  const mapped = mapDiamond(SEARCH_HTML[1], detail);
  assert.equal(mapped.img, null);
  assert.equal(mapped.certificate, null);
  assert.equal(mapped.shape, "Asscher");
});

test("syncSite caches a ready inventory with enriched diamonds", async () => {
  const restore = mockSite();
  try {
    const inv = await syncSite({ enrich: true });
    assert.equal(inv.status, "ready");
    assert.equal(inv.list.length, SEARCH_HTML.length);
    assert.equal(inv.enriched, SEARCH_HTML.length);
    const byId = Object.fromEntries(inv.list.map((d) => [d.id, d]));
    assert.equal(byId["8171"].clarity, "SI1");
    assert.equal(byId["8398"].colorName, "pink");
    assert.ok(fs.existsSync(syncConfig.inventoryFile), "inventory file written");
  } finally {
    restore();
  }
});

test("loadInventoryFromDisk restores the cached inventory into memory", () => {
  const restored = loadInventoryFromDisk();
  assert.ok(restored.list.length >= SEARCH_HTML.length);
  assert.equal(restored.status, "ready");
  const st = getSyncStatus();
  assert.equal(st.ok, true);
  assert.equal(st.count, restored.list.length);
});
