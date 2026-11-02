import {Component,type ReactNode} from 'react';
export default class AppErrorBoundary extends Component<{children:ReactNode},{failed:boolean}>{
 state={failed:false};
 static getDerivedStateFromError(){return{failed:true};}
 render(){
  if(this.state.failed)return <main className="cloud-login"><section className="cloud-login-card" role="alert"><h1>화면을 불러오지 못했습니다</h1><p>새 배포가 적용됐거나 화면 파일을 받지 못했습니다. 새로고침하면 저장된 계정 자료를 다시 불러옵니다.</p><button className="btn btn-primary" onClick={()=>location.reload()}>새로고침</button></section></main>;
  return this.props.children;
 }
}
