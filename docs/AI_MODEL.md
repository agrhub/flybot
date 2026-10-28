# Fruit fly detection models

FlyBot counts the insects on every trap photo with an object detection model. Two are available:

| `AI_PROVIDER` | Model | Where it runs |
|---|---|---|
| `opencv-lambda` (recommended on AWS) | YOLO26n exported to ONNX, run by OpenCV 5's DNN module, with a planning agent that proposes camera actions and answers deep-analysis questions | An AWS Lambda (arm64) deployed by flybot-aws; the model card, scores and training notes are in that repository |
| `roboflow` | RF-DETR Small trained on Roboflow (below) | Roboflow's serverless workflow, or your own Roboflow Inference server |

The rest of this page describes the Roboflow project and model, how FlyBot calls them, and how to retrain on photos reviewed in FlyBot. Reviewed photos are useful for either model.

## Roboflow project

| | |
|---|---|
| Project | [camos/fruit-fly-wmcqi](https://universe.roboflow.com/camos/fruit-fly-wmcqi) on Roboflow Universe (public) |
| Task | Object detection, one class: `fruit_fly` (oriental fruit fly, *Bactrocera* spp., "ruồi vàng") |
| Source images | 1,573 photos of yellow sticky cards and traps |
| Annotations | 85,307 boxes, about 54 flies per image (crowded cards are the norm) |
| Split | 1,404 train · 93 valid · 76 test |
| License | CC BY 4.0 (credit the project when reusing the dataset) |

### Dataset versions

| Version | Created | Images (after augmentation) | Preprocessing | Augmentation | Trained |
|---|---|---|---|---|---|
| 1 | 2026-10-04 | 3,596 (3,427 train) | none | 3 outputs per training image; horizontal and vertical flips; 15% grayscale | no |
| **2** | 2026-10-04 | 1,794 (1,625 train) | none | 2 outputs per training image; 15% grayscale | **yes** |

Validation and test images are never augmented, so both versions are scored on the same 93 + 76 photos.

## Model in production

| | |
|---|---|
| Architecture | RF-DETR Small (Roboflow's real-time DETR detector) |
| Trained from | dataset version 2, 79 epochs (about 3.5 hours) |
| Roboflow model | `fruit-fly-wmcqi/2`, deployed as `camos/fly-dataset-blzlm-a9mpu-2-rfdetr-small-t1` |
| Class name it returns | `ruoi_vang` (FlyBot maps it to `fruit_fly`, see below) |

| Split | mAP@50 | mAP@50-95 | Precision | Recall |
|---|---|---|---|---|
| Validation (93 images) | 98.0% | 71.1% | 96.4% | 97.0% |
| Test (76 images) | 96.1% | 71.9% | 93.1% | 92.0% |

The high mAP@50 means flies are found reliably; the lower mAP@50-95 reflects box tightness on small, overlapping insects, which does not affect counting.

## How FlyBot uses it

```
camera photo ─▶ S3 ─▶ Roboflow workflow ─▶ boxes ─▶ count, species, daily statistics, alerts
                         (serverless)
```

1. Every scheduled capture (and every manual "take a photo") is stored in S3 and sent to the **Roboflow workflow** set in `ROBOFLOW_WORKFLOW_URL`, by URL when the camera's picture link is reachable, otherwise as base64.
2. The workflow (`camos/workflows/fruit-fly-vfly-dataset-blzlm-a9mpu-2-rfdetr-small-t1-logic`) runs the model above and returns its `predictions`.
3. FlyBot ([server/src/services/aiService.js](../server/src/services/aiService.js)) turns each prediction into a box `[xmin, ymin, xmax, ymax]` with its confidence, and counts them. Any label that means fruit fly (`fruit_fly`, `ruoi_vang`, `ruồi vàng`, `Bactrocera`...) is stored as `fruit_fly` ([server/src/constants/species.js](../server/src/constants/species.js)); other class names are kept as they are. `other_insect` (bycatch such as Drosophila or bees, a class added to the Roboflow project on 2026-10-28) is stored and shown but never counted as a pest, like the other `NON_PEST_LABELS`.
4. The count feeds the snapshot's `pestCount`, the daily statistics (sticky traps: the day's rise; lure traps: the average per photo) and the threshold alerts.

Calls time out after 60 seconds and are retried 3 times (1, 2, 4 s apart), except when Roboflow refuses the request (4xx other than 408/429). Photos that still have no result are sent again every 15 minutes for 6 hours.

Google Vertex AI (Gemini) is not used for counting by default. It powers the assistant and the photo review ("Ask the assistant about this photo"). `AI_PROVIDER=vertex` or `both` makes Gemini count as well, which is slower and less precise on crowded cards.

### Settings

| Variable | Meaning |
|---|---|
| `AI_PROVIDER` | `roboflow` (the `.env.example` value; unset: `vertex`), `opencv-lambda`, `vertex`, `both` or `sentinel` |
| `ROBOFLOW_WORKFLOW_URL` | Workflow endpoint, `https://serverless.roboflow.com/camos/workflows/<workflow id>` |
| `ROBOFLOW_API_KEY` | Roboflow API key of the `camos` workspace (secret) |
| `ROBOFLOW_UPLOAD_PROJECT` | Project that receives reviewed photos for retraining, e.g. `fruit-fly-wmcqi` (empty = off) |
| `ROBOFLOW_UPLOAD_API_KEY` | Private API key for uploads, when `ROBOFLOW_API_KEY` is a publishable key (secret) |
| `ROBOFLOW_UPLOAD_CLASS` | Label given to uploaded boxes, `fruit_fly` (keep it the same as the project's class) |

### Changing the model

The model is chosen inside the Roboflow workflow, not in FlyBot. To roll out a newly trained version, open the workflow in Roboflow, point its model step at the new model and save: FlyBot uses it on the next photo, with no redeploy. To test a model before switching, copy the workflow, change the copy, and set `ROBOFLOW_WORKFLOW_URL` to it on a test instance.

The workflow can also run on your own hardware with [Roboflow Inference](https://inference.roboflow.com) (a Docker image, CPU or GPU); then set `ROBOFLOW_WORKFLOW_URL` to that server's workflow endpoint.

## Improving the model with FlyBot photos

### 1. Review photos in FlyBot

In a photo's details (Analytics → Detection history, or the latest photo of a trap), people either **Confirm** the AI count or **Correct the counts**. Each review is saved with the original AI count, so the history shows where the model is wrong. Analytics → Detection history → Export can also download the corrected photos of the last 90 days (AI count against human count).

### 2. Send them to Roboflow

An admin turns on **Settings → System settings → Retrain the AI with reviewed photos** (needs `ROBOFLOW_UPLOAD_PROJECT`). Every 15 minutes FlyBot uploads up to 20 reviewed photos to the training split of the project ([server/src/services/trainingSync.js](../server/src/services/trainingSync.js)):

| Review | Batch in Roboflow | Labels |
|---|---|---|
| Confirmed | `flybot-confirmed` | the AI boxes, as `fruit_fly` |
| Corrected | `flybot-corrections` | none: the boxes were wrong, so these need labeling |

Every image is tagged `review-confirmed` or `review-corrected`, `count-N` (the right count), `ai-count-M` (what the AI found) and `camera-SERIAL`. Failed uploads are retried up to 5 times; the card shows how many are pending, uploaded and failed.

### 3. Label the corrections

In Roboflow Annotate, open the `flybot-corrections` batch and draw a box around every fruit fly; the `count-N` tag tells how many there should be. Guidelines that match the existing dataset:

- One tight box per fly, including flies at the card edge or partly hidden.
- Do not box other insects, dirt, glare or grid lines. If you want to count other species later, add them as new classes rather than leaving them unlabeled as `fruit_fly`.
- Keep the class name `fruit_fly`.
- Photos that are unusable (blurred, fogged, covered card) are better deleted than labeled empty.

### 4. Generate a version and train

1. **Generate** a new dataset version. Keep the validation and test images as they are, so scores compare with version 2. Start from version 2's settings: no preprocessing, 2 outputs per training image, 15% grayscale. (Version 1 adds flips and more copies but was never trained, so there is no score to compare it with.)
2. **Train** RF-DETR Small, either from scratch like version 2 or starting from version 2's weights to save time.
3. **Compare** the test scores with the table above, and look at the confirmed and corrected FlyBot photos in the test results. Switch only when the new model is at least as good on the test split and better on your own farm photos.
4. Point the workflow at the new model (see [Changing the model](#changing-the-model)).

### Building a dataset for another pest or trap

The same steps work for a different insect, a different card color or a lure trap: collect photos from the cameras that will be used (same distance, light and card), label them in a new Roboflow project with one class per species, train, and create a workflow that returns `predictions`. FlyBot keeps class names other than fruit fly, so they show up as their own species in the counts and reports.
