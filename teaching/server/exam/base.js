const byId = id => document.getElementById(id);
const progress = new Set();
function done(section) {
  progress.add(section);
  byId('progress').textContent = `完成 ${progress.size}/7 节`;
  const tab = document.querySelector(`nav a[href="#${section}"]`);
  if (tab) tab.dataset.done = 'true';
}
function feedback(target, message, state = '') {
  target.textContent = message;
  target.dataset.state = state;
  target.classList.remove('flash');
  requestAnimationFrame(() => requestAnimationFrame(() => target.classList.add('flash')));
}
for (const form of document.querySelectorAll('form[data-quiz]')) {
  form.addEventListener('submit', event => {
    event.preventDefault();
    const item = form.querySelector('input:checked');
    const output = form.querySelector('output');
    if (!item) { feedback(output, '先选一项，再核对理由。', 'wrong'); return; }
    const correct = item.dataset.answer === 'true';
    feedback(output, item.dataset.why, correct ? 'right' : 'wrong');
    if (correct && form.dataset.complete !== 'false') done(form.closest('.lesson-block').id);
  });
}
function enableWriter(form, onCheck) {
  form.addEventListener('submit', event => {
    event.preventDefault();
    const draft = form.querySelector('textarea').value.trim();
    const output = form.querySelector('output');
    if (!draft) { feedback(output, '先写一段，再检查结构。', 'wrong'); return; }
    onCheck(draft, output);
  });
}
