import{expect,test}from'vitest';
import{apiProgress,aiFailureText}from'../src/domain/ai-status';
test('paused generation reports failure and preserves pending split counts',()=>{
 const result=apiProgress([{part:1,status:'paused',provider_error:'timeout'},{part:2,status:'waiting'}],2,0);
 expect(result).toMatchObject({state:'paused',completed:0,pending:2,importedQuestions:0});expect(result.message).toContain('시간');
});
test('completed validated content is immediately ready for learning',()=>{
 expect(apiProgress([{part:1,status:'completed'},{part:2,status:'completed'}],2,10)).toMatchObject({state:'completed',completed:2,importedQuestions:10});
 expect(aiFailureText('auth_error')).toContain('인증');
});
test('a safe persistence error takes precedence over an earlier provider failure',()=>{
 const result=apiProgress([{part:1,status:'paused',last_error:'processing_failed',detail:'단원 참조를 확인하세요.'}],2,0);
 expect(result.message).toBe('단원 참조를 확인하세요.');
});
