export function showModal(options) {
  const {
    title = '',
    body = '',
    footer = '',
    onClose = null,
  } = options;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <h2 class="modal-title">${title}</h2>
        <button class="modal-close">&times;</button>
      </div>
      <div class="modal-body">${body}</div>
      <div class="modal-footer">${footer}</div>
    </div>
  `;

  const closeBtn = overlay.querySelector('.modal-close');
  const closeModal = () => {
    overlay.remove();
    if (onClose) onClose();
  };

  closeBtn.addEventListener('click', closeModal);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  });

  document.body.appendChild(overlay);

  return { overlay, closeModal };
}

export function showConfirm(message, onConfirm) {
  const footer = `
    <button class="btn btn-secondary" data-action="cancel">Cancel</button>
    <button class="btn btn-danger" data-action="confirm">Confirm</button>
  `;

  const { closeModal } = showModal({
    title: 'Confirm Action',
    body: `<p>${message}</p>`,
    footer,
  });

  const modal = document.querySelector('.modal');
  modal.querySelector('[data-action="confirm"]').addEventListener('click', () => {
    closeModal();
    onConfirm();
  });
  modal.querySelector('[data-action="cancel"]').addEventListener('click', closeModal);
}
