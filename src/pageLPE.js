import { auth } from "./firebaseConfig.js";
import { signOut } from "firebase/auth";
import {
  doc,
  setDoc,
  getDoc,
  getDocs,
  serverTimestamp,
  deleteDoc,
  collection
} from "firebase/firestore";
import { db } from "./firebaseConfig.js";
import Swal from "sweetalert2";
import { marked } from "marked";
import Handsontable from 'handsontable';
import 'handsontable/dist/handsontable.full.min.css';
import html2canvas from 'html2canvas';
import jsPDF from 'jspdf';

// marked 라이브러리 설정 추가
marked.setOptions({
  breaks: true,  // 줄바꿈을 <br>로 변환
  gfm: true,     // GitHub Flavored Markdown 활성화
  headerIds: false,  // 헤더 ID 자동 생성 비활성화
  mangle: false   // 이메일 주소 자동 링크 비활성화
});

let currentUser = null;
let baseConversation = [];
let userConversation = [];
let selectedScenarioId = null;
let hot; // handsontable 인스턴스
const SPECIAL_SCENARIO_ID = "scenario_1762818829737";
let specialScenarioImage = null;
let currentFeedbackPrompt = null; // 현재 사용 중인 피드백 프롬프트 (수정 가능)

document.addEventListener("DOMContentLoaded", () => {
  // undoBtn을 선택적으로 가져오기
  const undoBtn = document.getElementById("undo-btn");
  const feedbackBtn = document.getElementById("feedbackBtn");
  const inputText = document.getElementById("inputText");
  specialScenarioImage = document.getElementById("scenario-special-image");

  auth.onAuthStateChanged(async (user) => {
    if (user) {
      currentUser = user;
      document.getElementById("userInfo").textContent = `👤 ${user.displayName} 님`;
      document.getElementById("logoutBtn").style.display = 'inline-block';
      await loadScenario();
      await loadUserSavedResults();
      await checkFeedbackSettings();
    } else {
      document.getElementById("userInfo").textContent = '🔐 로그인 후 이용해 주세요.';
      document.getElementById("logoutBtn").style.display = 'none';
      Swal.fire({
        icon: "warning",
        title: "로그인이 필요합니다",
        text: "메인 페이지로 이동합니다.",
        confirmButtonText: "확인",
      }).then(() => {
        window.location.href = "/index.html";
      });
    }
  });

  document.getElementById("logoutBtn").addEventListener("click", async () => {
    await signOut(auth);
    window.location.href = "/index.html";
  });

  // undoBtn이 존재할 때만 이벤트 리스너 추가
  if (undoBtn) {
    undoBtn.addEventListener("click", () => {
      if (userConversation.length > 0) {
        userConversation.pop();
        renderExcelTable();
      }
    });
  }

  // Tab 전환 기능
  const tabButtons = document.querySelectorAll('.tab-button');
  const tabPanes = document.querySelectorAll('.tab-pane');
  
  tabButtons.forEach(button => {
    button.addEventListener('click', () => {
      const targetTab = button.getAttribute('data-tab');
      
      // 모든 탭 버튼과 패널에서 active 제거
      tabButtons.forEach(btn => btn.classList.remove('active'));
      tabPanes.forEach(pane => pane.classList.remove('active'));
      
      // 클릭한 탭 버튼과 해당 패널에 active 추가
      button.classList.add('active');
      const targetPane = document.getElementById(`${targetTab}-result`);
      if (targetPane) {
        targetPane.classList.add('active');
      }
    });
  });

  // 피드백 받기 버튼 이벤트 (대화문 + 피드백 저장)
  feedbackBtn.addEventListener("click", async () => {
    // 현재 Handsontable의 모든 데이터를 가져와서 중복 없이 구성
    const currentData = hot.getData();
    const allConv = [];
    
    // baseConversation 길이만큼은 제시된 대화문 (isUser: false)
    for (let i = 0; i < baseConversation.length; i++) {
      const row = currentData[i];
      if (row[0]?.trim() && row[1]?.trim()) {
        allConv.push({
          speaker: row[0].trim(),
          message: row[1].trim(),
          isUser: false
        });
      }
    }
    
    // baseConversation 이후는 사용자 입력 (isUser: true)
    for (let i = baseConversation.length; i < currentData.length; i++) {
      const row = currentData[i];
      if (row[0]?.trim() && row[1]?.trim()) {
        allConv.push({
          speaker: row[0].trim(),
          message: row[1].trim(),
          isUser: true
        });
      }
    }
    
    if (allConv.length === 0) {
      Swal.fire({
        icon: "warning",
        title: "대화 입력 필요",
        text: "대화를 입력해 주세요."
      });
      return;
    }
    
    // 사용자 입력 대화문 추출
    const userConversations = allConv.filter(e => e.isUser);
    
    // 사용자 입력 대화가 없으면 확인 후 진행
    if (userConversations.length === 0) {
      const result = await Swal.fire({
        icon: "question",
        title: "사용자 입력 대화 없음",
        text: "사용자가 입력한 대화가 없습니다. 그래도 피드백을 받으시겠습니까?",
        showCancelButton: true,
        confirmButtonText: "확인",
        cancelButtonText: "취소"
      });
      
      if (!result.isConfirmed) {
        return;
      }
    }

    feedbackBtn.disabled = true;
    
    // Line by Line 결과 탭으로 전환
    document.querySelector('.tab-button[data-tab="line-by-line"]').classList.add('active');
    document.querySelector('.tab-button[data-tab="feedback"]').classList.remove('active');
    document.getElementById('line-by-line-result').classList.add('active');
    document.getElementById('feedback-result').classList.remove('active');
    
    const lineByLinePane = document.getElementById('line-by-line-result');
    const feedbackPane = document.getElementById('feedback-result');

    try {
      // 1단계: 전체 대화문을 맥락으로 하여 사용자 입력 대화만 Line by Line 분석
      lineByLinePane.innerHTML = "⏳ 1단계: Line by Line 분석 중...";
      
      // 전체 대화문 생성 (맥락 제공용)
      const fullConversationText = allConv
        .map((entry, idx) => {
          const prefix = entry.isUser ? "[사용자 입력] " : "[제시된 대화] ";
          return `${prefix}대화 ${idx}: ${entry.speaker}: ${entry.message}`;
        })
        .join('\n');
      
      // 사용자 입력 대화문만 별도로 표시 (분석 대상 명시)
      const userConversationText = userConversations
        .map((entry, idx) => `대화 ${idx}: ${entry.speaker}: ${entry.message}`)
        .join('\n');
      
      // 수정된 decisionPrompt: 전체 맥락을 참고하되 사용자 입력만 분석
      const modifiedDecisionPrompt = `${decisionPrompt}

**중요 지시사항**:
- 위에 제공된 전체 대화문을 맥락으로 참고하세요.
- 하지만 분석은 **"사용자 입력 대화문"** 섹션에 표시된 교사 발화에 대해서만 수행하세요.
- "row" 필드는 사용자 입력 대화문의 인덱스(0부터 시작)를 사용하세요.
- 전체 대화의 흐름과 맥락을 고려하여 사용자 입력 대화문의 교사 발화를 분석하세요.

=== 전체 대화문 (맥락 참고용) ===
${fullConversationText}

=== 사용자 입력 대화문 (분석 대상) ===
${userConversationText}`;
      
      console.log('📊 Line by Line 분석 시작:');
      console.log('- 전체 대화:', allConv.length, '개');
      console.log('- 분석 대상 (사용자 입력):', userConversations.length, '개');
      
      const analysisResult = await getAssistantsAPIDecision(modifiedDecisionPrompt);
      
      // JSON 파싱
      let decisions = [];
      try {
        let jsonText = analysisResult.trim();
        if (jsonText.includes('```json')) {
          jsonText = jsonText.split('```json')[1].split('```')[0].trim();
        } else if (jsonText.includes('```')) {
          jsonText = jsonText.split('```')[1].split('```')[0].trim();
        }
        decisions = JSON.parse(jsonText);
        console.log('✅ Line by Line 분석 완료:', decisions.length, '개 발화 분석됨');
      } catch (parseError) {
        console.error('JSON 파싱 실패:', parseError);
        console.log('원본 응답:', analysisResult);
        throw new Error('Line by Line 분석 결과를 파싱할 수 없습니다.');
      }

      // Line by Line 결과를 테이블 형식으로 표시
      let lineByLineHTML = '<h3 style="color: #2563eb; margin-bottom: 1rem;">📊 Line by Line 분석 결과</h3>';
      lineByLineHTML += '<table style="width: 100%; border-collapse: collapse; margin-top: 1rem;">';
      lineByLineHTML += '<thead><tr style="background: #f3f4f6;"><th style="padding: 0.75rem; text-align: left; border: 1px solid #e5e7eb;">발화자</th><th style="padding: 0.75rem; text-align: left; border: 1px solid #e5e7eb;">대화</th><th style="padding: 0.75rem; text-align: center; border: 1px solid #e5e7eb;">TMSSR</th><th style="padding: 0.75rem; text-align: center; border: 1px solid #e5e7eb;">Potential</th></tr></thead>';
      lineByLineHTML += '<tbody>';
      
      // 전체 사용자 입력 대화문을 순회하면서 표시
      userConversations.forEach((conv, idx) => {
        // decisions 배열에서 해당 발화를 찾기 (speaker와 message로 매칭)
        const matchedDecision = decisions.find(d => 
          d.speaker === conv.speaker && 
          d.message === conv.message
        );
        
        // 발화자가 "교사"인 경우에만 TMSSR과 Potential 표시
        if (conv.speaker === '교사' && matchedDecision) {
          const potentialColor = matchedDecision.potential === 'High' ? '#10b981' : '#ef4444';
          lineByLineHTML += `<tr>
            <td style="padding: 0.75rem; border: 1px solid #e5e7eb;">${conv.speaker}</td>
            <td style="padding: 0.75rem; border: 1px solid #e5e7eb;">${conv.message}</td>
            <td style="padding: 0.75rem; text-align: center; border: 1px solid #e5e7eb; font-weight: 500;">${matchedDecision.tmssr || '-'}</td>
            <td style="padding: 0.75rem; text-align: center; border: 1px solid #e5e7eb; font-weight: 600; color: ${potentialColor};">${matchedDecision.potential || '-'}</td>
          </tr>`;
        } else {
          // 학생 발화이거나 교사 발화지만 분석 결과가 없는 경우
          lineByLineHTML += `<tr>
            <td style="padding: 0.75rem; border: 1px solid #e5e7eb;">${conv.speaker}</td>
            <td style="padding: 0.75rem; border: 1px solid #e5e7eb;">${conv.message}</td>
            <td style="padding: 0.75rem; text-align: center; border: 1px solid #e5e7eb;">-</td>
            <td style="padding: 0.75rem; text-align: center; border: 1px solid #e5e7eb;">-</td>
          </tr>`;
        }
      });
      
      lineByLineHTML += '</tbody></table>';
      lineByLinePane.innerHTML = lineByLineHTML;

      // 2단계: Line by Line 결과를 바탕으로 피드백 생성
      feedbackPane.innerHTML = "⏳ 2단계: 피드백 생성 중...";
      
      // 시나리오 대화문과 사용자 입력 대화문을 구분하여 텍스트 생성
      const providedConversations = allConv.filter(e => !e.isUser);
      
      let conversationText = "";
      
      if (providedConversations.length > 0) {
        conversationText += "=== 제시된 대화문 (시나리오) ===\n";
        conversationText += providedConversations.map(e => `${e.speaker}: ${e.message}`).join("\n");
      }
      
      if (userConversations.length > 0) {
        if (conversationText) conversationText += "\n\n";
        conversationText += "=== 사용자 입력 대화문 ===\n";
        conversationText += userConversations.map(e => `${e.speaker}: ${e.message}`).join("\n");
      }

      // 분석 결과를 피드백 프롬프트에 포함
      const analysisSummary = decisions
        .map(d => `- ${d.speaker}: "${d.message}" → TMSSR: ${d.tmssr}, Potential: ${d.potential}`)
        .join('\n');
      
      // 현재 사용 중인 프롬프트 가져오기 (수정된 프롬프트가 있으면 사용, 없으면 기본값)
      const promptToUse = currentFeedbackPrompt || feedbackPrompt;
      const enhancedFeedbackPrompt = `${promptToUse}\n\n**사용자 입력 대화문의 Line by Line 분석 결과:**\n${analysisSummary}\n\n위 분석 결과를 참고하여 더 구체적이고 실용적인 피드백을 제공해주세요.`;

      const feedback = await getAssistantFeedback(conversationText, enhancedFeedbackPrompt);
      
      // 마크다운 파싱 시 에러 처리 추가
      let parsedFeedback;
      try {
        parsedFeedback = marked.parse(feedback);
      } catch (parseError) {
        console.error('마크다운 파싱 오류:', parseError);
        // 파싱 실패 시 원본 텍스트를 그대로 표시하되, 줄바꿈 처리
        parsedFeedback = feedback.replace(/\n/g, '<br>');
      }
      
      feedbackPane.innerHTML = parsedFeedback;
      if (window.MathJax) MathJax.typeset();

      // inputText에는 구분 없이 전체 대화문 표시 (기존 동작 유지)
      const simpleConversationText = allConv.map(e => `${e.speaker}: ${e.message}`).join("\n");
      inputText.value = simpleConversationText;

      if (currentUser) {
        const timestamp = new Date();
        const docId = `${currentUser.uid}_lessonPlayFeedback_${timestamp.getTime()}`;
        await setDoc(doc(db, "lessonPlayResponses", docId), {
          uid: currentUser.uid,
          displayName: currentUser.displayName,
          email: currentUser.email,
          scenarioId: selectedScenarioId,
          createdAt: serverTimestamp(),
          type: 'feedback',
          conversation: allConv,
          feedback: feedback,
          potentialAnalysis: decisions // 분석 결과도 함께 저장
        });

        Swal.fire({
          icon: "success",
          title: "피드백 제출 완료",
          text: "대화와 GPT 피드백이 제출되었습니다!"
        });

        // 전체 결과를 다시 불러와서 2열 레이아웃으로 표시
        await loadUserSavedResults();

        userConversation = [];
        renderExcelTable();
      }
    } catch (err) {
      console.error("피드백 오류:", err);
      lineByLinePane.innerHTML = `<p style="color: #ef4444;">⚠️ ${err.message || '분석에 실패했습니다.'}</p>`;
      feedbackPane.innerHTML = `<p style="color: #ef4444;">⚠️ 피드백 생성에 실패했습니다.</p>`;
      Swal.fire({
        icon: "error",
        title: "피드백 실패",
        text: err.message || "GPT 피드백을 생성하거나 저장하는 데 실패했습니다."
      });
    }
    feedbackBtn.disabled = false;
  });

  // Handsontable 초기화
  createExcelTable();
  
  // 폰트 적용 상태 확인
  setTimeout(() => {
    console.log('폰트 적용 상태 확인:', {
      bodyFont: getComputedStyle(document.body).fontFamily,
      tableFont: getComputedStyle(document.getElementById('excel-table')).fontFamily
    });
  }, 1000);
  
  // 프롬프트 확인/수정 기능 초기화
  initPromptModal();
  
  // 행 추가/삭제 버튼 이벤트
  document.getElementById('add-row').onclick = () => {
    // 행 추가는 항상 맨 마지막에 추가 (커서 위치와 무관)
    try {
      hot.alter('insert_row', hot.countRows(), 1);
    } catch (e) {
      try {
        hot.alter('insert_row_below', hot.countRows() - 1, 1);
      } catch (e2) {
        alert("Handsontable 버전 호환 문제가 있습니다.");
      }
    }
  };
  
  document.getElementById('del-row').onclick = () => {
    const sel = hot.getSelected();
    if (sel && sel.length > 0) {
      const selectedRow = sel[0][0];
      // 제시된 대화문은 삭제 불가
      if (selectedRow < baseConversation.length) {
        Swal.fire("⚠️ 알림", "제시된 대화문은 삭제할 수 없습니다.", "warning");
        return;
      }
      // 사용자가 추가한 행만 삭제 가능
      hot.alter('remove_row', selectedRow);
    }
  };

  // 확장/축소 버튼 이벤트
  document.getElementById('expand-toggle').addEventListener('click', () => {
    const table = document.getElementById('excel-table');
    const button = document.getElementById('expand-toggle');
    
    if (table.classList.contains('expanded')) {
      // 축소
      table.classList.remove('expanded');
      button.textContent = '📏 확장';
      button.classList.remove('expanded');
      button.title = '테이블 확장';
    } else {
      // 확장
      table.classList.add('expanded');
      button.textContent = '📏 축소';
      button.classList.add('expanded');
      button.title = '테이블 축소';
    }
  });

  // 제출 버튼 이벤트 (대화문만 저장)
  document.getElementById('submit-btn').addEventListener('click', async () => {
    if (!currentUser) {
      Swal.fire({
        icon: "warning",
        title: "로그인 필요",
        text: "로그인이 필요합니다."
      });
      return;
    }

    // 현재 Handsontable에서 사용자 입력이 있는지 확인
    const currentData = hot.getData();
    let hasUserInput = false;
    
    for (let i = baseConversation.length; i < currentData.length; i++) {
      const row = currentData[i];
      if (row[0]?.trim() && row[1]?.trim()) {
        hasUserInput = true;
        break;
      }
    }
    
    if (!hasUserInput) {
      Swal.fire({
        icon: "warning",
        title: "대화 입력 필요",
        text: "사용자 대화를 입력해 주세요."
      });
      return;
    }

    if (!selectedScenarioId) {
      Swal.fire("❌ 시나리오 없음", "저장할 시나리오가 선택되지 않았습니다.", "error");
      return;
    }

    const timestamp = new Date();
    const docId = `${currentUser.uid}_lessonPlay_${timestamp.getTime()}`;

    try {
      // 현재 Handsontable의 모든 데이터를 가져와서 중복 없이 구성
      const currentData = hot.getData();
      const allConv = [];
      
      // baseConversation 길이만큼은 제시된 대화문 (isUser: false)
      for (let i = 0; i < baseConversation.length; i++) {
        const row = currentData[i];
        if (row[0]?.trim() && row[1]?.trim()) {
          allConv.push({
            speaker: row[0].trim(),
            message: row[1].trim(),
            isUser: false
          });
        }
      }
      
      // baseConversation 이후는 사용자 입력 (isUser: true)
      for (let i = baseConversation.length; i < currentData.length; i++) {
        const row = currentData[i];
        if (row[0]?.trim() && row[1]?.trim()) {
          allConv.push({
            speaker: row[0].trim(),
            message: row[1].trim(),
            isUser: true
          });
        }
      }

      await setDoc(doc(db, "lessonPlayResponses", docId), {
        uid: currentUser.uid,
        displayName: currentUser.displayName,
        email: currentUser.email,
        createdAt: serverTimestamp(),
        scenarioId: selectedScenarioId,
        type: 'conversation', // 제출 타입 구분
        conversation: allConv
      });

      Swal.fire("✅ 제출 완료", "대화가 제출되었습니다.", "success");

      // 화면에 결과 추가
      renderSavedResult({
        id: docId,
        createdAt: timestamp,
        type: 'conversation',
        conversation: allConv
      });

      userConversation = [];
      renderExcelTable();
    } catch (err) {
      console.error("제출 실패:", err);
      Swal.fire("❌ 제출 실패", "다시 시도해주세요.", "error");
    }
  });
});

// Handsontable 생성 함수
function createExcelTable() {
  const container = document.getElementById('excel-table');
  hot = new Handsontable(container, {
    data: [['', '']], // 빈 데이터로 시작
    colHeaders: ['발화자', '대화'],
    rowHeaders: true,
    contextMenu: true,
    colWidths: [120, 300], // 발화자 열 너비 증가
    minRows: 2,
    minCols: 2,
    licenseKey: 'non-commercial-and-evaluation',
    width: '100%',
    height: 'auto',
    stretchH: 'all',
    manualRowResize: true,
    manualColumnResize: true,
    autoWrapRow: true,
    autoWrapCol: true,
    autoRowSize: true,
    outsideClickDeselects: false,
    rowHeights: 50, // 행 높이 증가
    className: 'custom-handsontable',
    cells: function(row, col, prop) {
      // 기본 대화(서버 제공)는 읽기 전용으로 설정
      if (row < baseConversation.length) {
        return { readOnly: true };
      }
      // 사용자 입력 대화는 편집 가능
      return { readOnly: false };
    },
    afterChange: function(changes, source) {
      if (source === 'edit') {
        updateUserConversation();
      }
    },
    // 첫 번째 열(발화자) 정렬 설정
    columns: [
      { data: 0, className: 'htCenter' },
      { data: 1, className: 'htLeft' }
    ]
  });
}

// Handsontable 데이터를 userConversation으로 변환 (실제로는 사용하지 않음)
function updateUserConversation() {
  // 이 함수는 더 이상 실제로 사용되지 않습니다.
  // 저장할 때 직접 Handsontable에서 데이터를 가져옵니다.
  console.log("updateUserConversation called - but not used for storage");
}

// Handsontable에 데이터 렌더링
function renderExcelTable() {
  // hot 변수가 초기화되지 않았으면 함수 종료
  if (!hot) {
    console.log('Handsontable이 아직 초기화되지 않았습니다.');
    return;
  }

  const allData = [
    ...baseConversation.map(e => [e.speaker, e.message]),
    ...userConversation.map(e => [e.speaker, e.message])
  ];
  
  // 최소 2행 유지
  if (allData.length < 2) {
    allData.push(['', '']);
  }
  
  hot.loadData(allData);
  
  // 기본 대화 행들을 읽기 전용으로 설정
  for (let i = 0; i < baseConversation.length; i++) {
    hot.setCellMeta(i, 0, 'readOnly', true);
    hot.setCellMeta(i, 1, 'readOnly', true);
  }
  
  // 사용자가 추가한 행들에 user-added-row 클래스 적용
  for (let i = baseConversation.length; i < hot.countRows(); i++) {
    hot.setCellMeta(i, 0, 'className', 'user-added-row');
    hot.setCellMeta(i, 1, 'className', 'user-added-row');
  }
  
  // 테이블 새로고침
  hot.render();
}

// 🎛️ 피드백 설정 확인 및 UI 업데이트
async function checkFeedbackSettings() {
  try {
    const feedbackDoc = await getDoc(doc(db, "lessonPlaySettings", "feedback"));
    const pageContainer = document.querySelector('.page-container');
    
    if (feedbackDoc.exists()) {
      const data = feedbackDoc.data();
      if (data.enabled) {
        // 피드백 기능 활성화
        pageContainer.classList.remove('feedback-disabled');
      } else {
        // 피드백 기능 비활성화
        pageContainer.classList.add('feedback-disabled');
      }
    } else {
      // 기본값: 비활성화
      pageContainer.classList.add('feedback-disabled');
    }
  } catch (error) {
    console.error("피드백 설정 확인 실패:", error);
    // 오류 시 기본값으로 비활성화
    document.querySelector('.page-container').classList.add('feedback-disabled');
  }
}

// 🔵 시나리오 불러오기 및 초기화
async function loadScenario() {
  try {
    const configDoc = await getDoc(doc(db, "lessonPlayScenarios", "config"));
    const selectedId = configDoc.exists() ? configDoc.data().selectedScenarioId : null;
    if (!selectedId) throw new Error("선택된 시나리오 ID가 없습니다.");
    selectedScenarioId = selectedId;
    updateSpecialScenarioVisuals();

    const scenarioDoc = await getDoc(doc(db, "lessonPlayScenarios", selectedScenarioId));
    if (!scenarioDoc.exists()) throw new Error("선택된 시나리오 문서를 찾을 수 없습니다.");
    const scenarioData = scenarioDoc.data();

    document.querySelector(".scenario-description").textContent = scenarioData.scenarioText || "";

    baseConversation = [];
    userConversation = [];
    if (Array.isArray(scenarioData.starterConversation)) {
      scenarioData.starterConversation.forEach(entry => {
        baseConversation.push(entry);
      });
    }
    
    // Handsontable이 초기화된 후에만 renderExcelTable 호출
    if (hot) {
      renderExcelTable();
    }
  } catch (error) {
    updateSpecialScenarioVisuals(false);
    console.error("시나리오 로딩 실패:", error);
    Swal.fire("시나리오 로딩 실패", error.message, "error");
  }
}

function updateSpecialScenarioVisuals(forceVisible) {
  const shouldShow = typeof forceVisible === "boolean"
    ? forceVisible
    : selectedScenarioId === SPECIAL_SCENARIO_ID;
  if (specialScenarioImage) {
    specialScenarioImage.classList.toggle("is-visible", shouldShow);
  }
}



// 🔵 Firestore에서 내 저장 결과 모두 불러와 2열로 구분해서 보여주기
async function loadUserSavedResults() {
  const snapshot = await getDocs(collection(db, "lessonPlayResponses"));
  const container = document.getElementById("saved-results-container");
  container.innerHTML = "";

  // 제출 결과와 피드백 결과를 분리
  const conversationResults = [];
  const feedbackResults = [];
  
  snapshot.forEach(docSnap => {
    const data = docSnap.data();
    if (
      data.uid === currentUser.uid &&
      data.scenarioId === selectedScenarioId &&
      data.conversation
    ) {
      const createdAt = data.createdAt?.toDate?.() || new Date();
      const result = {
        id: docSnap.id,
        createdAt,
        conversation: data.conversation,
        feedback: data.feedback,
        potentialAnalysis: data.potentialAnalysis || null
      };
      
      if (data.type === 'feedback') {
        feedbackResults.push(result);
      } else {
        conversationResults.push(result);
      }
    }
  });
  
  // 최신순 내림차순 정렬
  conversationResults.sort((a, b) => b.createdAt - a.createdAt);
  feedbackResults.sort((a, b) => b.createdAt - a.createdAt);
  
  // 2열 레이아웃으로 결과 표시
  renderResultsInColumns(conversationResults, feedbackResults);
}

// 🔵 2열 레이아웃으로 결과 표시
function renderResultsInColumns(conversationResults, feedbackResults) {
  const container = document.getElementById("saved-results-container");
  
  // 2열 레이아웃 컨테이너 생성 - 간단하게
  const columnsContainer = document.createElement("div");
  columnsContainer.classList.add("results-columns");
  
  // 제출 결과 열 (왼쪽)
  const leftColumn = document.createElement("div");
  leftColumn.classList.add("results-column", "conversation-column");
  leftColumn.style.display = "none"; // ← 추가
  leftColumn.innerHTML = `
    <h3 class="column-title">💬 제출된 대화문</h3>
    <div class="column-content"></div>
  `;
  
  // 피드백 결과 열 (오른쪽)
  const rightColumn = document.createElement("div");
  rightColumn.classList.add("results-column", "feedback-column");
  rightColumn.innerHTML = `
    <h3 class="column-title">📝 피드백 받은 대화문</h3>
    <div class="column-content"></div>
  `;
  
  // 제출 결과 렌더링
  const leftContent = leftColumn.querySelector(".column-content");
  if (conversationResults.length === 0) {
    leftContent.innerHTML = '<p class="no-results">아직 제출된 대화문이 없습니다.</p>';
  } else {
    conversationResults.forEach(result => {
      leftContent.appendChild(renderSavedResult(result, 'conversation'));
    });
  }
  
  // 피드백 결과 렌더링
  const rightContent = rightColumn.querySelector(".column-content");
  if (feedbackResults.length === 0) {
    rightContent.innerHTML = '<p class="no-results">아직 피드백을 받은 대화문이 없습니다.</p>';
  } else {
    feedbackResults.forEach(result => {
      rightContent.appendChild(renderSavedResult(result, 'feedback'));
    });
  }
  
  // 컨테이너에 추가
  columnsContainer.appendChild(leftColumn);
  columnsContainer.appendChild(rightColumn);
  container.appendChild(columnsContainer);
}

// 🔵 카드로 저장 결과 출력 (수정됨 - Handsontable 사용)
function renderSavedResult({ id, createdAt, conversation, feedback, potentialAnalysis }, type = 'conversation') {
  const box = document.createElement("div");
  box.classList.add("saved-result", `result-${type}`);
  box.setAttribute("data-id", id);

  const header = document.createElement("div");
  header.classList.add("saved-header");
  
  // 타입에 따른 아이콘과 텍스트 (클릭 가능하도록 수정) - 기본적으로 접혀있으므로 ▶ 사용
  if (type === 'feedback') {
    header.innerHTML = `<span class="header-text" onclick="toggleResult(this)">📝 ${createdAt.toLocaleString('ko-KR')} 피드백 제출됨 ▶</span>`;
  } else {
    header.innerHTML = `<span class="header-text" onclick="toggleResult(this)">💬 ${createdAt.toLocaleString('ko-KR')} 제출됨 ▶</span>`;
  }

  // 불러오기 버튼 추가
  const loadBtn = document.createElement("button");
  loadBtn.classList.add("load-btn");
  loadBtn.textContent = "불러오기";
  loadBtn.onclick = () => loadSavedResult(conversation, box);
  
  const delBtn = document.createElement("button");
  delBtn.classList.add("delete-btn");
  delBtn.textContent = "삭제";
  delBtn.onclick = () => deleteSavedResult(id, box);
  
  header.appendChild(loadBtn);
  // header.appendChild(delBtn);
  box.appendChild(header);

  // 내용을 result-content로 감싸기
  const contentDiv = document.createElement("div");
  contentDiv.classList.add("result-content");
  contentDiv.style.display = "none"; // 기본적으로 접혀있음

  // Handsontable 컨테이너 생성
  const tableContainer = document.createElement("div");
  tableContainer.id = `saved-table-${id}`;
  tableContainer.classList.add("conversation-table"); // 다운로드 함수를 위해 클래스 추가
  tableContainer.style.width = "100%";
  tableContainer.style.marginTop = "1rem";
  
  // Handsontable 데이터 준비
  const hasAnalysis = potentialAnalysis && Array.isArray(potentialAnalysis) && potentialAnalysis.length > 0;
  const hasTeacherSpeech = conversation.some(e => e.speaker === '교사');
  const useFourColumns = hasAnalysis && hasTeacherSpeech;
  
  const tableData = conversation.map(entry => {
    // potentialAnalysis에서 해당 발화 찾기
    let tmssr = '';
    let potential = '';
    
    if (useFourColumns && entry.speaker === '교사') {
      const matchedDecision = potentialAnalysis.find(d => 
        d.speaker === entry.speaker && 
        d.message === entry.message
      );
      if (matchedDecision) {
        tmssr = matchedDecision.tmssr || '';
        potential = matchedDecision.potential || '';
      }
    }
    
    // 모든 행이 같은 컬럼 수를 가져야 함
    if (useFourColumns) {
      return [entry.speaker, entry.message, tmssr, potential];
    } else {
      return [entry.speaker, entry.message];
    }
  });
  
  // 컬럼 헤더 설정
  const colHeaders = useFourColumns
    ? ['발화자', '대화', 'TMSSR', 'Potential']
    : ['발화자', '대화'];
  
  // Handsontable 생성 (비동기로 처리)
  setTimeout(() => {
    const hot = new Handsontable(tableContainer, {
      data: tableData,
      colHeaders: colHeaders,
      rowHeaders: true,
      readOnly: true, // 읽기 전용
      colWidths: useFourColumns
        ? [120, 300, 120, 100]
        : [120, 300],
      minRows: 1,
      minCols: colHeaders.length,
      licenseKey: 'non-commercial-and-evaluation',
      width: '100%',
      height: 'auto',
      stretchH: 'all',
      autoWrapRow: true,
      autoWrapCol: true,
      autoRowSize: true,
      className: 'saved-conversation-table',
      cells: function(row, col, prop) {
        const cellProperties = {};
        const entry = conversation[row];
        
        // 사용자 입력 행 스타일
        if (entry && entry.isUser) {
          cellProperties.className = 'user-entry';
        }
        
        // Potential 컬럼 스타일링 (4번째 컬럼, 인덱스 3)
        if (useFourColumns && col === 3 && entry && entry.speaker === '교사') {
          const potentialValue = tableData[row][3];
          if (potentialValue === 'High') {
            cellProperties.className = (cellProperties.className || '') + ' potential-high';
          } else if (potentialValue === 'Low') {
            cellProperties.className = (cellProperties.className || '') + ' potential-low';
          }
        }
        
        return cellProperties;
      }
    });
    
    // Handsontable 인스턴스를 컨테이너에 저장 (나중에 필요할 수 있음)
    tableContainer._hotInstance = hot;
  }, 100);
  
  contentDiv.appendChild(tableContainer);

  // 피드백이 있는 경우에만 표시
  if (feedback && type === 'feedback') {
    const feedbackBox = document.createElement("div");
    feedbackBox.classList.add("feedback-area");
    feedbackBox.innerHTML = marked.parse(feedback);
    
    // 다운로드 버튼 추가
    const downloadControls = document.createElement("div");
    downloadControls.classList.add("download-controls");
    downloadControls.innerHTML = `
      <button class="download-btn" onclick="downloadFeedbackAsImage(this)">🖼️ 이미지</button>
      <button class="download-btn" onclick="downloadFeedbackAsPdf(this)">📄 PDF</button>
    `;
    
    contentDiv.appendChild(feedbackBox);
    contentDiv.appendChild(downloadControls);
  }

  box.appendChild(contentDiv);

  return box;
}

// 🔵 저장된 결과 불러오기
function loadSavedResult(conversation, domElement) {
  try {
    // 현재 Handsontable 데이터 초기화
    const allData = [];
    
    // 제시된 대화문은 그대로 유지
    for (let i = 0; i < baseConversation.length; i++) {
      allData.push([baseConversation[i].speaker, baseConversation[i].message]);
    }
    
    // 저장된 사용자 대화문 추가
    conversation.forEach(entry => {
      if (entry.isUser) {
        allData.push([entry.speaker, entry.message]);
      }
    });
    
    // 최소 2행 유지
    if (allData.length < 2) {
      allData.push(['', '']);
    }
    
    // Handsontable에 데이터 로드
    hot.loadData(allData);
    
    // 기본 대화 행들을 읽기 전용으로 설정
    for (let i = 0; i < baseConversation.length; i++) {
      hot.setCellMeta(i, 0, 'readOnly', true);
      hot.setCellMeta(i, 1, 'readOnly', true);
    }
    
    // 사용자가 추가한 행들에 user-added-row 클래스 적용
    for (let i = baseConversation.length; i < hot.countRows(); i++) {
      hot.setCellMeta(i, 0, 'className', 'user-added-row');
      hot.setCellMeta(i, 1, 'className', 'user-added-row');
    }
    
    // 테이블 새로고침
    hot.render();
    
    // 성공 메시지 표시
    Swal.fire({
      icon: "success",
      title: "불러오기 완료",
      text: "저장된 대화문이 입력창에 불러와졌습니다!",
      timer: 2000,
      showConfirmButton: false
    });
    
  } catch (error) {
    console.error("불러오기 실패:", error);
    Swal.fire({
      icon: "error",
      title: "불러오기 실패",
      text: "대화문을 불러오는 중 오류가 발생했습니다."
    });
  }
}

// 🔵 결과 카드 토글 (접기/펼치기) - 전역 함수로 등록
window.toggleResult = function(headerElement) {
  const resultCard = headerElement.closest('.saved-result');
  const content = resultCard.querySelector('.result-content');
  const isExpanded = content.style.display !== 'none';
  
  if (isExpanded) {
    // 접기
    content.style.display = 'none';
    headerElement.innerHTML = headerElement.innerHTML.replace(' ▼', ' ▶');
  } else {
    // 펼치기
    content.style.display = 'block';
    headerElement.innerHTML = headerElement.innerHTML.replace(' ▶', ' ▼');
  }
};

// 🔵 카드 삭제
async function deleteSavedResult(docId, domElement) {
  const result = await Swal.fire({
    title: "정말 삭제하시겠습니까?",
    icon: "warning",
    showCancelButton: true,
    confirmButtonText: "삭제",
    cancelButtonText: "취소"
  });
  if (!result.isConfirmed) return;

  try {
    await deleteDoc(doc(db, "lessonPlayResponses", docId));
    domElement.remove();
    Swal.fire({
      icon: "success",
      title: "삭제 완료",
      text: "카드가 삭제되었습니다!"
    });
  } catch (err) {
    console.error("삭제 실패:", err);
    Swal.fire({
      icon: "error",
      title: "삭제 실패",
      text: "삭제 중 오류가 발생했습니다."
    });
  }
}


// 🔵 GPT Assistant 피드백 생성 함수 (page1과 동일)
const apiKey = import.meta.env.VITE_OPENAI_API_KEY;
const assistantId = import.meta.env.VITE_OPENAI_ASSISTANT_ID;
const vectorStoreId = import.meta.env.VITE_VECTOR_STORE_ID;

// 환경 변수 디버깅
console.log('OpenAI API Key:', apiKey ? '설정됨' : '설정되지 않음');
console.log('OpenAI Assistant ID:', assistantId ? '설정됨' : '설정되지 않음');
console.log('Vector Store ID:', vectorStoreId ? '설정됨' : '설정되지 않음');

// 환경 변수 검증
if (!apiKey || !assistantId) {
  console.error('OpenAI 환경 변수가 설정되지 않았습니다!');
  console.error('VITE_OPENAI_API_KEY:', apiKey);
  console.error('VITE_OPENAI_ASSISTANT_ID:', assistantId);
}

// Decision 프롬프트 (TMSSR 요소 및 Potential 판단용)
const decisionPrompt = `
다음은 교사와 학생의 대화입니다. 
첨부한 파일에 수록된 TMSSR Framework의 내용을 바탕으로, 각 교사의 발화를 분석해주세요.

**응답 형식**: 반드시 다음 JSON 형식으로만 응답해주세요:
\`\`\`json
[
  {
    "row": 0,
    "speaker": "교사",
    "message": "원본 발화 내용",
    "tmssr": "Eliciting/Responding/Facilitating/Extending 중 하나",
    "potential": "High/Low"
  }
]
\`\`\`

**분석 기준**:
1. TMSSR Framework의 네 가지 요소의 하위범주를 먼저 판단한 뒤, 네 가지 요소로 범주화 해주세요.
2. 첨부된 파일의 TMSSR Framework의 네 가지 요소의 각 하위범주의 예시를 참고하여 판단해주세요.
3. Eliciting은 교사가 학생의 아이디어를 조사하고 이해하는 데 목적이 있고, Facilitating은 교사가 문제의 풀이를 위해 정보를 제공하거나 특정 경로로 유도하는 방식으로 학생의 아이디어를 발전시키는 데 목적이 있다, 
4. Extending은 교사가 모든 경우에 대한 일반화를 지향하는 발언이고, "관계"를 찾게 하는 것은 Facilitating에 해당하는 경우가 많음.
5. 사용자의 입력이 3~4회 일어난 이후에는, 교사가 '왜' 또는 '관계'를 묻는 경우는 Eliciting이 아니다. 

**주의사항**:
- 교사의 발화만 분석해주세요 (학생 발화는 제외)
- 분석 시 직전 학생 발화의 맥락을 고려하여 교사의 의도를 추론하세요.
- 소인수분해의 연산이나 소수의 거듭제곱으로 표현하는 것은 단순한 계산이다. 
- "row" 필드는 제시된 "대화 N" 의 N 값을 그대로 사용하세요 (0부터 시작)
- ⚠️ 반드시 JSON 배열만 출력하고, JSON 외의 어떤 설명, 문장, 해설도 포함하지 마세요.
- 첨부된 파일의 TMSSR Framework 내용을 반드시 참고하여 판단해주세요
`;

const feedbackPrompt = `
다음은 교사와 학생의 대화 또는 수업 기록입니다. 
첨부한 문서에 수록된 TMSSR Framework의 내용을 바탕으로, 사용자와 가상의 학생 사이에 이루어진 대화를 분석하여 피드백을 제공해줘.

**⚠️ 반드시 다음 구조로 작성해주세요:**

## 1. Eliciting (유도하기)
- 이 범주에 해당하는 교사 발화를 분석하고 해석
- 학생의 수학적 사고에 미치는 영향 평가
- 개선 방안 제안

## 2. Responding (반응하기)
- 이 범주에 해당하는 교사 발화를 분석하고 해석
- 학생의 수학적 사고에 미치는 영향 평가
- 개선 방안 제안

## 3. Facilitating (촉진하기)
- 이 범주에 해당하는 교사 발화를 분석하고 해석
- 학생의 수학적 사고에 미치는 영향 평가
- 개선 방안 제안

## 4. Extending (확장하기)
- 이 범주에 해당하는 교사 발화를 분석하고 해석
- 학생의 수학적 사고에 미치는 영향 평가
- 개선 방안 제안

**중요 지시사항:**
- 반드시 위 4개 범주별로 섹션을 나눠서 작성해주세요
- 각 범주에 해당하는 교사 발화가 없으면 "해당 범주에 해당하는 발화가 없습니다"라고 표시해주세요
- 피드백은 반드시 **마크다운 형식**으로 작성해주세요 (제목은 ##, 리스트는 -, 강조는 **)
- 학생과 교사의 대화를 그대로 반복하지 말고, 핵심 내용을 요약하고 분석 중심으로 작성해주세요
- 첨부된 문서의 내용을 참고하여 TMSSR Framework에 기반한 분석을 명확히 반영해주세요
`;

// OpenAI Assistants API 호출 (Decision 용 - Line by Line 분석)
async function getAssistantsAPIDecision(conversationText) {
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
    'OpenAI-Beta': 'assistants=v2'
  };

  console.log('🔵 Assistants API (Decision) 호출 시작');
  console.log('📝 ASSISTANT_ID:', assistantId);
  console.log('📦 VECTOR_STORE_ID:', vectorStoreId || '(환경 변수 없음, Assistant 기본 설정 사용)');

  // Assistant 정보 확인
  try {
    const assistantInfoRes = await fetch(`https://api.openai.com/v1/assistants/${assistantId}`, {
      method: 'GET',
      headers
    });
    const assistantInfo = await assistantInfoRes.json();
    console.log('🤖 Assistant 정보:', {
      name: assistantInfo.name,
      model: assistantInfo.model,
      tools: assistantInfo.tools,
      tool_resources: assistantInfo.tool_resources
    });
    
    const vectorStoreIds = assistantInfo.tool_resources?.file_search?.vector_store_ids;
    if (!vectorStoreIds || vectorStoreIds.length === 0) {
      console.error('❌ Vector Store가 연결되지 않았습니다!');
      throw new Error('Vector Store가 설정되지 않았습니다. Assistant에 Vector Store를 연결해주세요.');
    } else {
      console.log('✅ Vector Store ID:', vectorStoreIds[0]);
    }
  } catch (error) {
    if (error.message.includes('Vector Store')) {
      throw error;
    }
    console.warn('⚠️ Assistant 정보 조회 실패:', error);
  }

  // Thread 생성
  const threadBody = {};
  if (vectorStoreId) {
    threadBody.tool_resources = {
      file_search: {
        vector_store_ids: [vectorStoreId]
      }
    };
    console.log('📦 Thread에 Vector Store 포함:', vectorStoreId);
  }
  
  const threadRes = await fetch('https://api.openai.com/v1/threads', {
    method: 'POST',
    headers,
    body: JSON.stringify(threadBody)
  });
  
  if (!threadRes.ok) {
    const errorData = await threadRes.json();
    console.error('❌ Thread 생성 실패:', errorData);
    throw new Error('Thread 생성 실패');
  }
  
  const threadData = await threadRes.json();
  const threadId = threadData.id;
  console.log('✅ Thread 생성 완료:', threadId);

  // 메시지 추가
  const messageRes = await fetch(`https://api.openai.com/v1/threads/${threadId}/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      role: 'user',
      content: conversationText
    })
  });
  
  if (!messageRes.ok) {
    const errorData = await messageRes.json();
    console.error('❌ 메시지 추가 실패:', errorData);
    throw new Error('메시지 추가 실패');
  }
  
  console.log('✅ 메시지 추가 완료');

  // Run 실행
  const runBody = {
    assistant_id: assistantId,
    instructions: '반드시 JSON 형식으로만 응답하고, 다른 설명은 추가하지 마세요. 첨부된 파일의 TMSSR Framework 내용을 반드시 참고하여 각 교사 발화를 분석해주세요.',
    tools: [{ type: 'file_search' }],
    tool_choice: 'required'
  };
  
  if (vectorStoreId) {
    runBody.tool_resources = {
      file_search: {
        vector_store_ids: [vectorStoreId]
      }
    };
    console.log('🔥 Run에 Vector Store 명시:', vectorStoreId);
  }
  
  const runRes = await fetch(`https://api.openai.com/v1/threads/${threadId}/runs`, {
    method: 'POST',
    headers,
    body: JSON.stringify(runBody)
  });
  
  if (!runRes.ok) {
    const errorData = await runRes.json();
    console.error('❌ Run 실행 실패:', errorData);
    throw new Error('Run 실행 실패');
  }
  
  const runData = await runRes.json();
  const runId = runData.id;
  console.log('✅ Run 시작:', runId);

  // Run 완료 대기
  let status = runData.status;
  let pollCount = 0;
  while (status !== 'completed') {
    await new Promise(resolve => setTimeout(resolve, 1000));
    pollCount++;
    
    const statusRes = await fetch(
      `https://api.openai.com/v1/threads/${threadId}/runs/${runId}`,
      { headers }
    );
    const statusData = await statusRes.json();
    status = statusData.status;
    
    console.log(`⏳ Polling ${pollCount}회: ${status}`);
    
    if (status === 'failed') {
      console.error('❌ Run 실패:', statusData);
      throw new Error('GPT 실행 실패');
    }
    
    if (status === 'expired') {
      throw new Error('Run 시간 초과');
    }
    
    if (pollCount > 60) {
      throw new Error('Run 완료 대기 시간 초과 (60초)');
    }
  }
  
  console.log('✅ Run 완료');

  // 메시지 가져오기
  const messagesRes = await fetch(
    `https://api.openai.com/v1/threads/${threadId}/messages`,
    { headers }
  );
  
  if (!messagesRes.ok) {
    const errorData = await messagesRes.json();
    console.error('❌ 메시지 가져오기 실패:', errorData);
    throw new Error('메시지 가져오기 실패');
  }
  
  const messagesData = await messagesRes.json();
  const assistantMessages = messagesData.data.filter(msg => msg.role === 'assistant');
  
  console.log('🤖 Assistant 메시지 개수:', assistantMessages.length);
  
  const result = assistantMessages
    .map(m => m.content[0].text.value)
    .join('\n')
    .replace(/【.*?†.*?】/g, '');
  
  console.log('✅ Assistants API (Decision) 호출 완료');
  
  return result;
}

async function getAssistantFeedback(userText, customPrompt = null) {
  // 환경 변수 검증
  if (!apiKey || !assistantId) {
    throw new Error('OpenAI API 키 또는 Assistant ID가 설정되지 않았습니다. .env 파일을 확인해주세요.');
  }

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    "OpenAI-Beta": "assistants=v2"
  };

  console.log('🔵 Assistants API (Feedback) 호출 시작');
  console.log('📝 ASSISTANT_ID:', assistantId);
  console.log('📦 VECTOR_STORE_ID:', vectorStoreId || '(환경 변수 없음, Assistant 기본 설정 사용)');

  // Assistant 정보 확인 (Vector Store 연결 상태 확인)
  try {
    const assistantInfoRes = await fetch(`https://api.openai.com/v1/assistants/${assistantId}`, {
      method: 'GET',
      headers
    });
    const assistantInfo = await assistantInfoRes.json();
    console.log('🤖 Assistant 정보:', {
      name: assistantInfo.name,
      model: assistantInfo.model,
      tools: assistantInfo.tools,
      tool_resources: assistantInfo.tool_resources
    });
    
    // Vector Store 확인
    const vectorStoreIds = assistantInfo.tool_resources?.file_search?.vector_store_ids;
    if (!vectorStoreIds || vectorStoreIds.length === 0) {
      console.warn('⚠️ Assistant에 Vector Store가 연결되지 않았습니다.');
      if (!vectorStoreId) {
        console.warn('⚠️ 환경 변수에도 VECTOR_STORE_ID가 없습니다. Vector Store 없이 진행합니다.');
      }
    } else {
      console.log('✅ Assistant에 연결된 Vector Store ID:', vectorStoreIds[0]);
    }
  } catch (error) {
    console.warn('⚠️ Assistant 정보 조회 실패:', error);
  }

  // Thread 생성 (Vector Store 포함)
  const threadBody = {};
  
  if (vectorStoreId) {
    threadBody.tool_resources = {
      file_search: {
        vector_store_ids: [vectorStoreId]
      }
    };
    console.log('📦 Thread에 Vector Store 포함:', vectorStoreId);
  } else {
    console.log('📦 Thread에 Vector Store 없이 생성 (Assistant 기본 설정 사용)');
  }
  
  const threadRes = await fetch("https://api.openai.com/v1/threads", {
    method: "POST",
    headers,
    body: JSON.stringify(threadBody)
  });
  
  if (!threadRes.ok) {
    const errorData = await threadRes.json();
    console.error('❌ Thread 생성 실패:', errorData);
    throw new Error('Thread 생성 실패');
  }
  
  const threadData = await threadRes.json();
  const threadId = threadData.id;
  console.log('✅ Thread 생성 완료:', threadId);

  // 메시지 추가
  // customPrompt가 있으면 사용, 없으면 기본 feedbackPrompt 사용
  const promptToUse = customPrompt || feedbackPrompt;
  
  await fetch(`https://api.openai.com/v1/threads/${threadId}/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      role: "user",
      content: `${promptToUse}\n\n${userText}`
    })
  });
  console.log('✅ 메시지 추가 완료');

  // Run 실행 (Vector Store 및 File Search 활성화)
  const runBody = {
    assistant_id: assistantId,
    instructions: "출력은 반드시 한국어 마크다운 형식으로 작성해주세요. 첨부된 파일의 TMSSR Framework 내용을 반드시 참고하여 피드백을 제공해주세요."
  };
  
  // Vector Store가 있으면 File Search tool 활성화
  if (vectorStoreId) {
    runBody.tools = [{ type: 'file_search' }];
    runBody.tool_resources = {
      file_search: {
        vector_store_ids: [vectorStoreId]
      }
    };
    console.log('🔥 Run에 Vector Store 및 File Search tool 명시:', vectorStoreId);
  } else {
    console.log('📝 Run에 Vector Store 없이 실행 (Assistant 기본 설정 사용)');
  }
  
  const runRes = await fetch(`https://api.openai.com/v1/threads/${threadId}/runs`, {
    method: "POST",
    headers,
    body: JSON.stringify(runBody)
  });
  
  if (!runRes.ok) {
    const errorData = await runRes.json();
    console.error('❌ Run 실행 실패:', errorData);
    throw new Error('Run 실행 실패');
  }
  
  const runData = await runRes.json();
  const runId = runData.id;
  console.log('✅ Run 시작:', runId);

  // Run 완료 대기
  let status = runData.status;
  let pollCount = 0;
  while (status !== "completed") {
    await new Promise(r => setTimeout(r, 1000));
    pollCount++;
    
    const statusRes = await fetch(`https://api.openai.com/v1/threads/${threadId}/runs/${runId}`, { headers });
    const statusData = await statusRes.json();
    status = statusData.status;
    
    console.log(`⏳ Polling ${pollCount}회: ${status}`);
    
    if (status === "failed") {
      console.error('❌ Run 실패:', statusData);
      throw new Error("GPT 실행 실패");
    }
    
    if (status === "expired") {
      throw new Error("Run 시간 초과");
    }
    
    if (pollCount > 60) {
      throw new Error("Run 완료 대기 시간 초과 (60초)");
    }
  }
  
  console.log('✅ Run 완료');

  // 메시지 가져오기
  const messagesRes = await fetch(`https://api.openai.com/v1/threads/${threadId}/messages`, { headers });
  
  if (!messagesRes.ok) {
    const errorData = await messagesRes.json();
    console.error('❌ 메시지 가져오기 실패:', errorData);
    throw new Error('메시지 가져오기 실패');
  }
  
  const messagesData = await messagesRes.json();
  const assistantMessages = messagesData.data.filter(msg => msg.role === "assistant");
  console.log('🤖 Assistant 메시지 개수:', assistantMessages.length);
  
  const result = assistantMessages
    .map(m => m.content[0].text.value)
    .join("\n")
    .replace(/【.*?†.*?】/g, '');
  
  console.log('✅ Assistants API (Feedback) 호출 완료');
  console.log('📦 Vector Store 활용 여부:', vectorStoreId ? '✅ 활용됨' : '❌ 활용 안 됨 (환경 변수 없음)');
  
  return result;
}

// 🖼️ 이미지 다운로드
async function downloadAsImage() {
  try {
    const feedbackArea = document.getElementById('result');
    
    // 피드백 영역이 비어있으면 경고
    if (feedbackArea.innerHTML.includes('placeholder') || feedbackArea.innerHTML.trim() === '') {
      Swal.fire({
        icon: 'warning',
        title: '피드백 없음',
        text: '먼저 피드백을 받아주세요.'
      });
      return;
    }

    // 로딩 표시
    Swal.fire({
      title: '이미지 생성 중...',
      allowOutsideClick: false,
      didOpen: () => {
        Swal.showLoading();
      }
    });

    // 피드백 영역을 이미지로 변환 (가로 길이 2배)
    const canvas = await html2canvas(feedbackArea, {
      backgroundColor: '#ffffff',
      scale: 2,
      width: feedbackArea.scrollWidth * 2,
      height: feedbackArea.scrollHeight,
      useCORS: true,
      allowTaint: true
    });

    // 이미지 다운로드
    const link = document.createElement('a');
    link.download = `피드백_${new Date().toISOString().split('T')[0]}.png`;
    link.href = canvas.toDataURL();
    link.click();

    Swal.fire({
      icon: 'success',
      title: '다운로드 완료!',
      text: '피드백이 이미지로 저장되었습니다.',
      timer: 2000,
      showConfirmButton: false
    });

  } catch (error) {
    console.error('이미지 다운로드 실패:', error);
    Swal.fire({
      icon: 'error',
      title: '다운로드 실패',
      text: '이미지 생성 중 오류가 발생했습니다.'
    });
  }
}

// 📄 PDF 다운로드
async function downloadAsPdf() {
  try {
    const feedbackArea = document.getElementById('result');
    
    // 피드백 영역이 비어있으면 경고
    if (feedbackArea.innerHTML.includes('placeholder') || feedbackArea.innerHTML.trim() === '') {
      Swal.fire({
        icon: 'warning',
        title: '피드백 없음',
        text: '먼저 피드백을 받아주세요.'
      });
      return;
    }

    // 로딩 표시
    Swal.fire({
      title: 'PDF 생성 중...',
      allowOutsideClick: false,
      didOpen: () => {
        Swal.showLoading();
      }
    });

    // 피드백 영역을 이미지로 변환 (가로 길이 2배)
    const canvas = await html2canvas(feedbackArea, {
      backgroundColor: '#ffffff',
      scale: 2,
      width: feedbackArea.scrollWidth * 2,
      height: feedbackArea.scrollHeight,
      useCORS: true,
      allowTaint: true
    });

    // PDF 생성 (가로 길이 2배)
    const imgData = canvas.toDataURL('image/png');
    const pdf = new jsPDF({
      orientation: 'landscape', // 가로 방향
      unit: 'px',
      format: [canvas.width, canvas.height]
    });

    // 이미지를 PDF에 추가
    pdf.addImage(imgData, 'PNG', 0, 0, canvas.width, canvas.height);

    // PDF 다운로드
    pdf.save(`피드백_${new Date().toISOString().split('T')[0]}.pdf`);

    Swal.fire({
      icon: 'success',
      title: '다운로드 완료!',
      text: '피드백이 PDF로 저장되었습니다.',
      timer: 2000,
      showConfirmButton: false
    });

  } catch (error) {
    console.error('PDF 다운로드 실패:', error);
    Swal.fire({
      icon: 'error',
      title: '다운로드 실패',
      text: 'PDF 생성 중 오류가 발생했습니다.'
    });
  }
}

// 🖼️ 피드백 이미지 다운로드
window.downloadFeedbackAsImage = async function(button) {
  try {
    const feedbackCard = button.closest('.saved-result');
    const feedbackArea = feedbackCard.querySelector('.feedback-area');
    
    if (!feedbackArea) {
      Swal.fire({
        icon: 'warning',
        title: '피드백 없음',
        text: '다운로드할 피드백이 없습니다.'
      });
      return;
    }

    // 로딩 표시
    Swal.fire({
      title: '이미지 생성 중...',
      allowOutsideClick: false,
      didOpen: () => {
        Swal.showLoading();
      }
    });

    // 다운로드용 임시 컨테이너 생성 (가로로 넓게)
    const tempContainer = document.createElement('div');
    tempContainer.style.cssText = `
      position: fixed;
      top: -9999px;
      left: -9999px;
      width: 1200px;
      background: white;
      padding: 40px;
      font-family: 'Noto Sans KR', sans-serif;
      font-size: 14px;
      line-height: 1.6;
      color: #333;
      box-sizing: border-box;
    `;
    
    // 피드백 내용을 가로로 넓게 배치
    tempContainer.innerHTML = `
      <div style="
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 40px;
        width: 100%;
      ">
        <div style="
          background: #f8fafc;
          padding: 20px;
          border-radius: 8px;
          border: 1px solid #e5e7eb;
        ">
          <h3 style="margin: 0 0 15px 0; color: #2563eb; font-size: 18px;">💬 대화문</h3>
          ${feedbackCard.querySelector('.conversation-table').outerHTML}
        </div>
        <div style="
          background: #f0f9ff;
          padding: 20px;
          border-radius: 8px;
          border: 1px solid #3b82f6;
        ">
          <h3 style="margin: 0 0 15px 0; color: #1e40af; font-size: 18px;">📝 AI 피드백</h3>
          ${feedbackArea.innerHTML}
        </div>
      </div>
    `;
    
    // 임시 컨테이너를 DOM에 추가
    document.body.appendChild(tempContainer);
    
    // 이미지로 변환
    const canvas = await html2canvas(tempContainer, {
      backgroundColor: '#ffffff',
      scale: 2,
      width: 1200,
      height: tempContainer.scrollHeight,
      useCORS: true,
      allowTaint: true
    });
    
    // 임시 컨테이너 제거
    document.body.removeChild(tempContainer);

    // 이미지 다운로드
    const link = document.createElement('a');
    const timestamp = new Date().toISOString().split('T')[0];
    link.download = `피드백_${timestamp}.png`;
    link.href = canvas.toDataURL();
    link.click();

    Swal.fire({
      icon: 'success',
      title: '다운로드 완료!',
      text: '피드백이 가로로 넓은 이미지로 저장되었습니다.',
      timer: 2000,
      showConfirmButton: false
    });

  } catch (error) {
    console.error('이미지 다운로드 실패:', error);
    Swal.fire({
      icon: 'error',
      title: '다운로드 실패',
      text: '이미지 생성 중 오류가 발생했습니다.'
    });
  }
};

// 📄 피드백 PDF 다운로드
window.downloadFeedbackAsPdf = async function(button) {
  try {
    const feedbackCard = button.closest('.saved-result');
    const feedbackArea = feedbackCard.querySelector('.feedback-area');
    
    if (!feedbackArea) {
      Swal.fire({
        icon: 'warning',
        title: '피드백 없음',
        text: '다운로드할 피드백이 없습니다.'
      });
      return;
    }

    // 로딩 표시
    Swal.fire({
      title: 'PDF 생성 중...',
      allowOutsideClick: false,
      didOpen: () => {
        Swal.showLoading();
      }
    });

    // 다운로드용 임시 컨테이너 생성 (가로로 넓게)
    const tempContainer = document.createElement('div');
    tempContainer.style.cssText = `
      position: fixed;
      top: -9999px;
      left: -9999px;
      width: 1200px;
      background: white;
      padding: 40px;
      font-family: 'Noto Sans KR', sans-serif;
      font-size: 14px;
      line-height: 1.6;
      color: #333;
      box-sizing: border-box;
    `;
    
    // 피드백 내용을 가로로 넓게 배치
    tempContainer.innerHTML = `
      <div style="
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 40px;
        width: 100%;
      ">
        <div style="
          background: #f8fafc;
          padding: 20px;
          border-radius: 8px;
          border: 1px solid #e5e7eb;
        ">
          <h3 style="margin: 0 0 15px 0; color: #2563eb; font-size: 18px;">💬 대화문</h3>
          ${feedbackCard.querySelector('.conversation-table').outerHTML}
        </div>
        <div style="
          background: #f0f9ff;
          padding: 20px;
          border-radius: 8px;
          border: 1px solid #3b82f6;
        ">
          <h3 style="margin: 0 0 15px 0; color: #1e40af; font-size: 18px;">📝 AI 피드백</h3>
          ${feedbackArea.innerHTML}
        </div>
      </div>
    `;
    
    // 임시 컨테이너를 DOM에 추가
    document.body.appendChild(tempContainer);
    
    // 이미지로 변환
    const canvas = await html2canvas(tempContainer, {
      backgroundColor: '#ffffff',
      scale: 2,
      width: 1200,
      height: tempContainer.scrollHeight,
      useCORS: true,
      allowTaint: true
    });
    
    // 임시 컨테이너 제거
    document.body.removeChild(tempContainer);

    // PDF 생성 (가로 방향)
    const imgData = canvas.toDataURL('image/png');
    const pdf = new jsPDF({
      orientation: 'landscape', // 가로 방향
      unit: 'px',
      format: [canvas.width, canvas.height]
    });

    // 이미지를 PDF에 추가
    pdf.addImage(imgData, 'PNG', 0, 0, canvas.width, canvas.height);

    // PDF 다운로드
    const timestamp = new Date().toISOString().split('T')[0];
    pdf.save(`피드백_${timestamp}.pdf`);

    Swal.fire({
      icon: 'success',
      title: '다운로드 완료!',
      text: '피드백이 가로로 넓은 PDF로 저장되었습니다.',
      timer: 2000,
      showConfirmButton: false
    });

  } catch (error) {
    console.error('PDF 다운로드 실패:', error);
    Swal.fire({
      icon: 'error',
      title: '다운로드 실패',
      text: 'PDF 생성 중 오류가 발생했습니다.'
    });
  }
};

// 📝 프롬프트 모달 초기화 및 관리
function initPromptModal() {
  const modal = document.getElementById('prompt-modal');
  const openBtn = document.getElementById('prompt-view-btn');
  const closeBtn = document.getElementById('prompt-modal-close');
  const saveBtn = document.getElementById('prompt-save-btn');
  const resetBtn = document.getElementById('prompt-reset-btn');
  const textarea = document.getElementById('prompt-textarea');
  
  // 모달 열기
  if (openBtn) {
    openBtn.addEventListener('click', () => {
      // 현재 프롬프트를 textarea에 표시 (수정된 것이 있으면 그것을, 없으면 기본값)
      textarea.value = currentFeedbackPrompt || feedbackPrompt;
      modal.style.display = 'flex';
    });
  }
  
  // 모달 닫기
  const closeModal = () => {
    modal.style.display = 'none';
  };
  
  if (closeBtn) {
    closeBtn.addEventListener('click', closeModal);
  }
  
  // 모달 배경 클릭 시 닫기
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        closeModal();
      }
    });
  }
  
  // 저장 버튼
  if (saveBtn) {
    saveBtn.addEventListener('click', () => {
      const newPrompt = textarea.value.trim();
      if (!newPrompt) {
        Swal.fire({
          icon: 'warning',
          title: '프롬프트 비어있음',
          text: '프롬프트를 입력해주세요.'
        });
        return;
      }
      
      currentFeedbackPrompt = newPrompt;
      closeModal();
      
      Swal.fire({
        icon: 'success',
        title: '저장 완료',
        text: '프롬프트가 저장되었습니다. 다음 피드백 생성부터 적용됩니다.',
        timer: 2000,
        showConfirmButton: false
      });
      
      console.log('✅ 프롬프트 저장됨:', currentFeedbackPrompt.substring(0, 100) + '...');
    });
  }
  
  // 기본값으로 복원 버튼
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      Swal.fire({
        icon: 'question',
        title: '기본값으로 복원',
        text: '기본 프롬프트로 복원하시겠습니까?',
        showCancelButton: true,
        confirmButtonText: '복원',
        cancelButtonText: '취소'
      }).then((result) => {
        if (result.isConfirmed) {
          textarea.value = feedbackPrompt;
          currentFeedbackPrompt = null;
          Swal.fire({
            icon: 'success',
            title: '복원 완료',
            text: '기본 프롬프트로 복원되었습니다.',
            timer: 2000,
            showConfirmButton: false
          });
        }
      });
    });
  }
}
