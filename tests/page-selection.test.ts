import {expect,test} from 'vitest';
import {newlySelected,selectPages,tocPages} from '../src/domain/pages';
test('physical page ranges support intervals, individual exclusions and all pages',()=>{expect(selectPages('15-18,22,!16',120,'18')).toEqual([15,17,22]);expect(selectPages('',5,'2,4')).toEqual([1,3,5]);expect(tocPages('',120)).toEqual([])});
test('invalid ranges never silently select unrelated pages',()=>{for(const range of ['0','5-2','1-121','1.5','-2'])expect(()=>selectPages(range,120)).toThrow();expect(()=>selectPages('1-3,!1,!2,!3',120)).toThrow()});
test('range changes process only additions without dropping prior history',()=>{expect(newlySelected([15,16,17],[16,17,18,18,22])).toEqual([18,22])});
