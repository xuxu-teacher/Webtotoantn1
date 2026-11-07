import React, { lazy, Suspense } from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import App from './App';
import './index.css';

// Phần Chấm phiếu (đăng nhập giáo viên) chỉ tải khi mở /cham-phieu — trang soạn KHBD không nặng thêm
const PaperApp = lazy(() => import('./cham-phieu/PaperApp'));

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route
          path="/cham-phieu/*"
          element={
            <Suspense fallback={<p style={{ padding: 24 }}>Đang tải…</p>}>
              <PaperApp />
            </Suspense>
          }
        />
        <Route path="*" element={<App />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
);
