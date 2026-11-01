import {expect,test}from'vitest';
import {pageOcrIndex,extractLocalOutline}from'../src/domain/pdf-index';
const item=(text:string,x:number,y:number,width=.6,height=.02)=>({text,x,y,width,height,confidence:.9});
test('OCR index uses normalized corner boxes and distinguishes native and OCR confidence',()=>{
 const page={number:18,width:595,height:842,source:'text',items:[item('함수의 성질',.1,.1,.4,.05)],words:[],text:'함수의 성질',warnings:[]};
 expect(pageOcrIndex('doc',page).text_blocks[0]).toMatchObject({bbox:[.1,.1,.5,.15000000000000002],source:'pdf_text',confidence:1,confidence_kind:'source_text'});
 expect(pageOcrIndex('doc',{...page,source:'ocr'}).text_blocks[0]).toMatchObject({confidence:.9,confidence_kind:'ocr_engine'});
});
test('local TOC keeps printed and physical pages separate and preserves hierarchy',()=>{
 const p={number:2,width:600,height:800,source:'text',items:[item('Ⅰ. 함수 ........ 10',.1,.1),item('1. 역함수 .... 12',.14,.2),item('2. 합성함수 .... 16',.14,.3)],text:'목차',warnings:[]};
 const unknown=extractLocalOutline([p],[2],40,null);expect(unknown.entries[0].pdfPage).toBeNull();
 const mapped=extractLocalOutline([p],[2],40,-3);expect(mapped.entries.map(e=>e.pdfPage)).toEqual([13,15,19]);expect(mapped.entries[1].parentId).toBe(mapped.entries[0].id);expect(mapped.entries.every(e=>e.needsReview)).toBe(true);
});
