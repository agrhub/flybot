# Numeric people check, so that no picture of a person reaches anyone (or any AI model) before the owner has seen it:
# YuNet faces at 2 scales and 4 rotations, the HOG person detector, Haar frontal faces. Prints counts only.
#   peoplecheck.py <files|dirs|globs>...      PEOPLE_STEP=n checks every n-th file of a folder;
#   PEOPLE_FAST=1 (screen recordings): upright only, no HOG, prints only the files it flags.  PEOPLE_THR: YuNet score (0.6).
# YuNet model: FLYBOT_FACE_MODEL, or flybot-aws's vendored copy next to this repository.
# Run: uv run --no-project --python 3.12 --with opencv-python-headless==4.10.0.84 python -I peoplecheck.py <...>
import sys, glob, os, cv2

HERE = os.path.dirname(os.path.abspath(__file__))
YUNET = os.environ.get('FLYBOT_FACE_MODEL') or os.path.normpath(os.path.join(
    HERE, '..', '..', '..', '..', 'flybot-aws', 'lambda', 'vision', 'sentinel', 'vision', 'models', 'face_detection_yunet_2023mar.onnx'))
if not os.path.exists(YUNET):
    sys.exit(f'YuNet model not found: {YUNET} (set FLYBOT_FACE_MODEL)')
FAST = os.environ.get('PEOPLE_FAST') == '1'
STEP = int(os.environ.get('PEOPLE_STEP', '1'))
THR = float(os.environ.get('PEOPLE_THR', '0.6'))

haar = cv2.CascadeClassifier(os.path.join(cv2.data.haarcascades, 'haarcascade_frontalface_default.xml'))
hog = cv2.HOGDescriptor()
hog.setSVMDetector(cv2.HOGDescriptor_getDefaultPeopleDetector())


def yunet(img, size):
    h, w = img.shape[:2]
    s = size / max(h, w)
    im = cv2.resize(img, (max(1, int(w * s)), max(1, int(h * s))))
    det = cv2.FaceDetectorYN.create(YUNET, "", (im.shape[1], im.shape[0]), THR, 0.3, 50)
    _, faces = det.detect(im)
    return [] if faces is None else [float(f[-1]) for f in faces]


files = []
for a in sys.argv[1:]:
    if any(c in a for c in '*?'):
        files += sorted(glob.glob(a))
    elif os.path.isdir(a):
        files += [os.path.join(a, f) for f in sorted(os.listdir(a)) if f.lower().endswith(('.jpg', '.jpeg', '.png', '.webp'))][::STEP]
    else:
        files.append(a)

flagged = 0
for f in files:
    img = cv2.imread(f)
    if img is None:
        print(f"ERR\t{f}")
        continue
    h, w = img.shape[:2]
    scores = []
    rots = (None,) if FAST else (None, cv2.ROTATE_90_CLOCKWISE, cv2.ROTATE_180, cv2.ROTATE_90_COUNTERCLOCKWISE)
    for rot in rots:
        im = img if rot is None else cv2.rotate(img, rot)
        for size in (640, 1280):
            scores += yunet(im, size)
    s = 960 / max(h, w)
    small = cv2.resize(img, (int(w * s), int(h * s)))
    g = cv2.equalizeHist(cv2.cvtColor(small, cv2.COLOR_BGR2GRAY))
    hf = len(haar.detectMultiScale(g, 1.1, 6, minSize=(30, 30)))
    hg = 0
    if not FAST:
        _, wts = hog.detectMultiScale(small, winStride=(8, 8))
        hg = int(sum(1 for x in wts if float(x) > 1.0))
    flag = 'FLAG' if scores else ('weak' if (hf or hg) else 'ok')
    flagged += flag == 'FLAG'
    if flag != 'ok' or not FAST:
        print(f"{flag}\t{os.path.basename(f)}\t{w}x{h}\tyunet={len(scores)} max={max(scores) if scores else 0:.2f} haar={hf} hog={hg}")
print(f"files={len(files)} flagged={flagged}")
