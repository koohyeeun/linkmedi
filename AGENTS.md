# Link Medi – 프로젝트 가이드 (AI/개발자용)

빌드 도구 없는 정적 웹앱. `index.html`을 열거나 GitHub Pages로 배포하면 바로 동작해요.

## 파일
- `index.html` – 마크업(헤더·로고 SVG·`#app`·`#modal`), MediaPipe CDN, `app.js` 로드
- `style.css` – 전체 스타일 (파랑/네이비 테마)
- `app.js` – 모든 로직 (ES module). `// ---- 섹션 ----` 주석으로 구역 구분:
  angles → analysis → questionnaire → findings(`judge`) → hospitals → summary →
  videoValidator → storage → sample → poseAnalysis → follow-up compare → app(화면·이벤트)

## 흐름
로그인(`#guest`) → 자가설문 2페이지 → 영상 업로드/분석(MediaPipe 각도·ROM) →
통합 결과(`viewResult`) → 병원 정렬·요약 모달 → 연계 / 자가관리(`viewDone`) / 재측정 비교(`compareWithPrev`)

## 규칙
- 참고용·진단 아님, 연계는 사용자가 누를 때만, 원본 영상은 전송하지 않음, 병원 데이터는 시뮬레이션
- 저장: `localStorage["linkmedi.assessments"]`
- 로컬 실행: `python -m http.server 8000` 후 http://localhost:8000 (module 사용으로 file:// 불가)
- 수정 시 테마와 위 규칙을 유지하고, 한 번에 한 기능씩 바꾸세요.
