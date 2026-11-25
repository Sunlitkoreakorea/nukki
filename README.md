# 누끼

사진 배경을 **원본 해상도 그대로** 지워 주는 무료 웹 도구. 사진은 서버로 올라가지 않고 브라우저 안에서만 처리됩니다.

https://sunlitkoreakorea.github.io/nukki/

- 모델: [BEN2 Base](https://huggingface.co/PramaLLC/BEN2) (MIT) — 처음 한 번 223MB를 받아 브라우저에 저장
- 실행: ONNX Runtime Web (WebGPU, 없으면 CPU)
- 가장자리: 1024 마스크를 색 안내 유도 필터로 원본 해상도 사진에 맞추고, 블러 융합으로 테두리에 섞인 배경색을 뺌
- 손보기: 지우기 / 되살리기 붓, 되돌리기, 배경색, PNG(투명) / JPG(배경색) 저장

웹용 ONNX Runtime에 없는 double 연산은 받은 모델을 브라우저에서 float32로 고쳐서 씁니다 (`onnx-patch.js`).
