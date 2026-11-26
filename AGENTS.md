# Link Medi – 프로젝트 가이드 (AI/개발자용)

빌드 도구 없는 단일 파일 정적 웹앱. `index.html` 하나에 CSS·JS가 모두 들어 있어요.

## 구조 (index.html)
- `<style>` – 전체 스타일
- 본문 – 5단계 섹션 `#step-1`~`#step-5` (자가설문 → 영상분석 → 위험결과 → 병원연계 → 비교·관리)
- `<script>` – 상태(`state`), 단계 이동(`goStep`), MediaPipe Pose 분석(`onPoseResults`, `finalizeAnalysis`),
  결과(`renderResultStep`), 병원(`renderHospitals`), 비교(`renderComparison`)

## 규칙
- 참고용·진단 아님, 연계는 사용자가 누를 때만, 원본 영상은 전송하지 않음, 병원 데이터는 예시
- MediaPipe는 jsdelivr CDN에서 로드 (인터넷 필요)
- 로컬 실행: `python -m http.server 8000` 후 http://localhost:8000
