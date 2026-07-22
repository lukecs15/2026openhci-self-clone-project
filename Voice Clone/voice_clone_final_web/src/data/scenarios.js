/**
 * scenarios.js — 三個情境的內容（文案 + 圖片 + 兩個立場設定）
 *
 * 情境文案來自專案的《情境描述》：同一個晚上的三段連續故事——
 * 工作坊深夜的去留 → 回家路上的阿嬤 → 家門前的那扇門。
 *
 * 影像素材（優先序：video → image → fallbackImage）：
 *   - video：情境短片，放 public/scenarios/scenario-N.mp4。情境導入頁
 *     以影片展示；辯論頁作為全螢幕半透明背景（VR 感）循環播放。
 *     檔案還沒放（404）時自動退回 image。
 *   - image：正式圖片路徑（scenario-N.jpg）。
 *   - fallbackImage：連圖片都沒放時退回的佔位 SVG。
 *
 * orbStyle：立場克隆形象的線條球骨架（波形設計五種人格骨架）：
 *   'E' 外向（黃綠）擴散環＋星芒 / 'A' 親和（暖橘）鏡像環抱＋雙股主波
 *   'C' 盡責（紫）緯度環秩序＋上下細軌 / 'N' 負向（紅）凌亂抖動＋鋸齒尖峰
 *   'O' 開放（藍）多傾角交錯＋三重諧波
 *
 * stancePrompt：該立場的核心主張，會跟 Big Five 摘要與使用者親口說的
 * 價值觀（觀念問題逐字稿）一起組進 persona_prompt（utils/stancePersona.js）。
 */

export const SCENARIOS = [
  {
    id: 'workshop-night',
    order: 1,
    title: '我現在該說我可以先回家嗎？',
    video: '/scenarios/scenario-1.mp4',
    image: '/scenarios/scenario-1.jpg',
    fallbackImage: '/scenarios/scenario-1.svg',
    description:
      '工作坊到了深夜十點半還沒結束，你已經累到無法思考。' +
      '今天是與伴侶的七週年紀念日，他傳來訊息：「你大概幾點會結束？」',
    question: '此刻的你，該留下來，還是開口說要先離開？',
    topicTitle:
      '工作坊深夜仍未結束，但已精疲力竭、且答應了伴侶七週年紀念日的約定——該留下來陪隊友完成工作，還是開口說自己要先回家',
    choices: {
      a: {
        label: '留下來，陪隊友把工作做完',
        shortLabel: '留下來',
        stanceName: '守責的我',
        orbStyle: 'C',
        hue: 255,
        stancePrompt:
          '你深信團隊此刻正需要每一個人：大家都一樣累卻還在撐，這時候先走等於把壓力留給別人。' +
          '紀念日可以補救、可以解釋，但共事的信任壞了很難修。你主張咬牙留下，把該做的做完再走。',
      },
      b: {
        label: '開口說明，現在就先回家',
        shortLabel: '先回家',
        stanceName: '重情的我',
        orbStyle: 'A',
        hue: 34,
        stancePrompt:
          '你深信人不是機器：疲累到無法思考的人留在這裡，貢獻有限，還賠上健康與最重要的關係。' +
          '七週年只有一次，伴侶已經在等了。你主張誠實向隊友說明狀況、交代好進度，然後準時離開——' +
          '這不是逃避，是對自己和身邊的人負責。',
      },
    },
  },
  {
    id: 'street-grandma',
    order: 2,
    title: '我現在該停下來幫這位阿嬤嗎？',
    video: '/scenarios/scenario-2.mp4',
    image: '/scenarios/scenario-2.jpg',
    fallbackImage: '/scenarios/scenario-2.svg',
    description:
      '深夜趕往捷運站赴伴侶的約，路邊一位阿嬤跌坐在地、站不起來。' +
      '四下無人——離她最近的，只有你。',
    question: '此刻的你，該停下來幫忙，還是趕去赴約？',
    topicTitle:
      '深夜趕路赴伴侶的七週年之約，途中遇見跌坐路邊、無人協助的阿嬤——該停下來幫她，還是先趕去見已經等了一整晚的伴侶',
    choices: {
      a: {
        label: '停下來，扶阿嬤一把',
        shortLabel: '停下幫忙',
        stanceName: '善良的我',
        orbStyle: 'A',
        hue: 34,
        stancePrompt:
          '你深信眼前這一刻只有你能接住她：附近沒有別人，深夜跌倒的老人家可能受傷、可能站不起來，' +
          '晚幾分鐘見伴侶可以解釋，錯過眼前需要幫助的人卻沒有第二次機會。你主張先停下來，確認她安全再走。',
      },
      b: {
        label: '快步通過，趕去赴約',
        shortLabel: '趕去赴約',
        stanceName: '守諾的我',
        orbStyle: 'E',
        hue: 95,
        stancePrompt:
          '你深信今晚已經對伴侶失約太多次：他從早上等到現在，每再晚一分鐘都是再多一分傷害。' +
          '阿嬤的狀況看起來還能撐，可以邊走邊打電話請求協助（例如通報 110 或附近的人），' +
          '不必親自留下。你主張把今晚最後的時間留給等了你七年的人。',
      },
    },
  },
  {
    id: 'door-moment',
    order: 3,
    title: '我現在該推開那扇門嗎？',
    video: '/scenarios/scenario-3.mp4',
    image: '/scenarios/scenario-3.jpg',
    fallbackImage: '/scenarios/scenario-3.svg',
    description:
      '七週年夜，你帶著禮物回家，玄關卻有一雙陌生的皮鞋，房裡傳來伴侶與別人親密的聲音。' +
      '你的手，停在門把上。',
    question: '此刻的你，該推開門，還是先離開？',
    topicTitle:
      '七週年當晚回到家，玄關有陌生的鞋、房裡傳來伴侶與他人親密的聲音，手已經放在門把上——該當場推門面對，還是先退開、冷靜之後再處理',
    choices: {
      a: {
        label: '推開門，當場面對一切',
        shortLabel: '推開門',
        stanceName: '直面的我',
        orbStyle: 'N',
        hue: 350,
        stancePrompt:
          '你深信此刻退開就等於允許自己被欺騙：證據就在門後，現在不面對，之後只會得到一套排練好的說詞。' +
          '七年的關係值得一個當面的真相，憤怒與委屈也需要出口。你主張現在就推開門，讓一切攤在眼前。',
      },
      b: {
        label: '放開門把，先離開冷靜',
        shortLabel: '先離開',
        stanceName: '沉著的我',
        orbStyle: 'O',
        hue: 200,
        stancePrompt:
          '你深信在情緒的最高點推門，說出口的話和做出的事都可能無法收回：也許真相就是最壞的那種，' +
          '也許還有你沒想到的可能。先退開不是懦弱，是把主導權留在自己手上——' +
          '整理好自己，選一個你準備好的時間與方式面對。你主張先放開門把，離開現場。',
      },
    },
  },
]

export function getScenarioByIndex(index) {
  return SCENARIOS[index] || null
}
