import assert from 'node:assert/strict';
import test from 'node:test';
import { pdf_page_wheel, type pdf_wheel_event, type pdf_scroll_position } from '../webview/pdf_paging';

const wheel: pdf_wheel_event = { deltaX: 0, deltaY: 100, deltaMode: 0, ctrlKey: false, metaKey: false, shiftKey: false };
const fit: pdf_scroll_position = { top: 0, height: 480, visible: 480, previous: true, next: true };

test('wheel scrolls normally inside a zoomed page and turns only at the requested edge', () => {
  const pager = new pdf_page_wheel();
  assert.deepEqual(pager.step(wheel, { ...fit, top: 100, height: 1200 }, 0), { page: 0, consume: false });
  assert.deepEqual(pager.step(wheel, { ...fit, top: 720, height: 1200 }, 20), { page: 1, consume: true });
});

test('trackpad movement accumulates but inertia cannot trigger a second page turn', () => {
  const pager = new pdf_page_wheel();
  const touch = { ...wheel, deltaY: 20 };
  for (let index = 0; index < 3; index++) assert.equal(pager.step(touch, fit, index * 16).page, 0);
  assert.equal(pager.step(touch, fit, 48).page, 1);
  for (let time = 64; time < 1000; time += 16) assert.equal(pager.step(wheel, fit, time).page, 0);
  assert.equal(pager.step(wheel, fit, 1300).page, 1, 'a new gesture can turn the next page');
});

test('reverse, line-mode and page-mode wheels preserve page bounds and ignore zoom/horizontal gestures', () => {
  assert.equal(new pdf_page_wheel().step({ ...wheel, deltaY: -5, deltaMode: 1 }, fit, 0).page, -1);
  assert.equal(new pdf_page_wheel().step({ ...wheel, deltaY: 1, deltaMode: 2 }, fit, 0).page, 1);
  for (const event of [{ ...wheel, ctrlKey: true }, { ...wheel, metaKey: true }, { ...wheel, shiftKey: true }, { ...wheel, deltaX: 200 }]) {
    assert.deepEqual(new pdf_page_wheel().step(event, fit, 0), { page: 0, consume: false });
  }
  assert.equal(new pdf_page_wheel().step({ ...wheel, deltaY: -100 }, { ...fit, previous: false }, 0).page, 0);
  assert.equal(new pdf_page_wheel().step(wheel, { ...fit, next: false }, 0).page, 0);
});
