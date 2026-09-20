import assert from 'node:assert/strict';
import test from 'node:test';
import { layout_pages, page_at, visible_pages, current_page, layout_document, page_group, adjacent_page } from '../webview/pdf_layout';

test('continuous geometry supports mixed page sizes, zoom and direct scrollbar jumps', () => {
  const pages = layout_pages([{ width: 600, height: 800 }, { width: 800, height: 600 }, { width: 600, height: 1200 }], 624, 824, 'page-width');
  assert.deepEqual(pages.map(page => [page.top, page.width, page.height]), [[0, 600, 800], [812, 600, 450], [1274, 600, 1200]]);
  assert.equal(page_at(pages, 1800), 2);
  assert.equal(page_at(pages, -10), 0);
  assert.equal(page_at(pages, 100000), 2);
  assert.deepEqual(visible_pages(pages, 700, 800), [0, 1, 2]);
  assert.equal(layout_pages([{ width: 600, height: 1200 }], 624, 624, 'page-fit')[0].height, 600);
});

test('large documents render the viewport and one prefetch page at any scroll position', () => {
  const pages = layout_pages(Array.from({ length: 10000 }, () => ({ width: 600, height: 800 })), 2000, 3000, .1);
  for (const offset of [0, 7000, 200000, 900000]) {
    const visible = visible_pages(pages, offset, 3000);
    assert.ok(visible.length < 40);
    assert.ok(visible.includes(page_at(pages, offset + 3000)));
    assert.equal(visible[0], page_at(pages, offset));
  }
  assert.deepEqual(visible_pages([], 0, 1000), []);
});


test('short landscape pages fill a tall viewport even when more than six pages are visible', () => {
  const pages = layout_pages(Array.from({ length: 20 }, () => ({ width: 720, height: 120 })), 300, 900, 'page-width');
  const visible = visible_pages(pages, 0, 900);
  assert.ok(visible.length > 6);
  assert.ok(visible.includes(page_at(pages, 900)));
});


test('the toolbar identifies the page occupying most of the viewport after a result is centered', () => {
  const pages = layout_pages(Array.from({ length: 3 }, () => ({ width: 600, height: 800 })), 624, 624, 'page-width');
  assert.equal(current_page(pages, 650, 600), 1);
});

test('single and spread layouts fit mixed pages and keep odd final pages reachable', async () => {
  const sizes = [{ width: 600, height: 800 }, { width: 800, height: 600 }, { width: 600, height: 1200 }];
  const spread = layout_document(sizes, 1436, 824, 'page-width', 'spread', 2);
  assert.deepEqual([...spread.boxes.keys()], [0, 1]);
  assert.equal(spread.boxes.get(0)!.scale, 1);
  assert.equal(spread.boxes.get(1)!.left, 612);
  assert.equal(spread.width, 1412);
  assert.equal(spread.height, 800);
  assert.deepEqual(page_group(3, 3, 'spread'), [2]);
  assert.equal(adjacent_page(2, 3, 'spread', 1), 3);
  assert.equal(adjacent_page(3, 3, 'spread', -1), 1);
  const single = layout_document(sizes, 624, 624, 'page-fit', 'single', 3);
  assert.deepEqual([...single.boxes.keys()], [2]);
  assert.equal(single.boxes.get(2)!.height, 600);
  assert.equal(single.boxes.get(2)!.left, 150);
  const enlarged = layout_document(sizes, 324, 624, 4, 'spread', 1);
  assert.equal(enlarged.width, 5612);
  assert.equal(enlarged.boxes.get(0)!.left, 0);
  assert.equal(enlarged.boxes.get(1)!.left, 2412);
});
