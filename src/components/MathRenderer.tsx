import { useEffect, useRef } from 'react';

declare global {
  interface Window {
    MathJax?: any;
  }
}

interface Props {
  /** Một trong hai: mathml (chuỗi <math>...</math> đầy đủ) hoặc latex (không có dấu $). */
  mathml?: string;
  latex?: string;
}

/**
 * Render công thức bằng MathJax (tải qua CDN trong index.html, component
 * "tex-mml-chtml" hỗ trợ cả input MathML lẫn TeX) — thay cho việc tự viết bộ
 * chuyển đổi/hiển thị công thức, để đảm bảo hiển thị đúng chuẩn toán học.
 */
export default function MathRenderer({ mathml, latex }: Props) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    if (mathml) {
      el.innerHTML = mathml;
    } else if (latex) {
      el.textContent = `\\(${latex}\\)`;
    } else {
      el.textContent = '';
      return;
    }

    const mj = window.MathJax;
    if (mj?.typesetPromise) {
      mj.typesetPromise([el]).catch(() => {
        /* ignore lỗi hiển thị lẻ tẻ, không chặn phần còn lại của trang */
      });
    } else if (mj?.startup?.promise) {
      mj.startup.promise.then(() => mj.typesetPromise?.([el]));
    }
  }, [mathml, latex]);

  return <span ref={ref} className="math" />;
}
