import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'

// 刻意不包 React.StrictMode：StrictMode 在開發模式會把 effect 掛載/卸載
// 執行兩次，DebateStage 的「掛載即 connect + init_debate_session」會對
// 後端重複建立辯論 session（兩個背景生成 task 搶同一條 WS 的事件時序），
// 這不是可以用 ref guard 簡單擋掉的（斷線重連時 guard 又必須放行）。
// 展場體驗的互動流程以真實掛載行為為準。
ReactDOM.createRoot(document.getElementById('root')).render(<App />)
