"""Draiq 编辑器后端服务。

提供 /api/export/dxf 接口，将前端提交的图纸 JSON 转换为 DXF 文件。
前端静态资源由 Nuxt3 提供，本服务不再挂载静态文件。
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from functools import lru_cache
from io import StringIO
from math import atan2, cos, degrees, hypot, pi, sin
from pathlib import Path
import re
from typing import Literal, Optional

import ezdxf
from ezdxf import bbox, const
from ezdxf.colors import aci2rgb
from ezdxf.enums import TextEntityAlignment
from fastapi import FastAPI, HTTPException, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from starlette.exceptions import HTTPException as StarletteHTTPException
from pydantic import BaseModel, Field, root_validator

try:
    from pydantic import field_validator
except ImportError:
    from pydantic import validator as field_validator

BASE_DIR = Path(__file__).resolve().parent
EXPORT_TIMEZONE = timezone(timedelta(hours=8))

app = FastAPI(title="Draiq 绘图服务")


def validation_message(error: dict) -> str:
    """将 Pydantic 的常见参数校验错误转换为中文，兼容两个主要版本。"""
    message = error.get("msg", "")
    if re.search(r"[\u4e00-\u9fff]", message):
        return message.removeprefix("Value error, ")
    error_type = error.get("type", "")
    if error_type in {"value_error.missing", "missing"}:
        return "缺少必填字段"
    if error_type in {"value_error.jsondecode", "json_invalid"}:
        return "请求内容不是有效的 JSON 数据"
    if error_type in {"value_error.const", "literal_error"}:
        return "字段值不在允许的选项范围内"
    if error_type in {"type_error.none.not_allowed", "none_required"}:
        return "字段值不符合空值要求"
    if error_type in {"type_error.float", "type_error.integer", "float_parsing", "float_type", "int_parsing", "int_type", "finite_number"}:
        return "字段必须是有效数字"
    if error_type in {"type_error.list", "list_type"}:
        return "字段必须是列表"
    if error_type in {"type_error.dict", "dict_type", "model_attributes_type", "model_type"}:
        return "字段必须是有效的数据对象"
    if error_type in {"type_error.str", "string_type"}:
        return "字段必须是文字"
    if error_type in {"type_error.bool", "bool_parsing", "bool_type"}:
        return "字段必须是布尔值"
    if error_type in {"value_error.number.not_gt", "greater_than", "value_error.number.not_ge", "greater_than_equal"}:
        return "数值低于允许的范围"
    if error_type in {"value_error.number.not_lt", "less_than", "value_error.number.not_le", "less_than_equal"}:
        return "数值高于允许的范围"
    return "字段值不符合要求"


@app.exception_handler(RequestValidationError)
async def request_validation_error(_request: Request, error: RequestValidationError) -> JSONResponse:
    """保留接口校验错误结构，只将可读提示转换为中文。"""
    details = [{**item, "msg": validation_message(item)} for item in error.errors()]
    return JSONResponse(status_code=422, content=jsonable_encoder({"detail": details}, custom_encoder={ValueError: str}))


@app.exception_handler(StarletteHTTPException)
async def http_error(_request: Request, error: StarletteHTTPException) -> JSONResponse:
    """为接口和框架产生的 HTTP 错误提供中文提示。"""
    detail = error.detail
    if isinstance(detail, str) and not re.search(r"[\u4e00-\u9fff]", detail):
        detail = {400: "请求参数无效", 404: "请求的接口不存在", 405: "此接口不支持当前请求方法"}.get(error.status_code, "服务请求失败")
    return JSONResponse(status_code=error.status_code, content={"detail": detail}, headers=error.headers)

# 允许 Nuxt 前端跨域调用（开发环境）。
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:8010", "http://127.0.0.1:8010"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


Point = list[float]
EDITOR_STYLE_APPID = "TOOLS_ERA_STYLE"
EDITOR_DASHED_LINETYPE = "TOOLS_DASHED"
EDITOR_DASHDOT_LINETYPE = "TOOLS_DASHDOT"


class CurveGeometry(BaseModel):
    type: Literal["arc", "ellipse"]
    center: Point
    axisX: Point
    axisY: Point
    startParameter: float
    sweepParameter: float


class LayerDefinition(BaseModel):
    """图纸图层及其默认样式。"""

    name: str
    color: str = "#2764AF"
    lineWidth: Optional[float] = None
    lineType: Literal["solid", "dashed", "dashdot"] = "solid"
    dxfLineType: Optional[str] = "CONTINUOUS"
    lineDash: Optional[list[float]] = None
    visible: bool = True
    frozen: bool = False
    locked: bool = False


class DimensionStyleDefinition(BaseModel):
    """DXF DIMSTYLE 的编辑器可视化子集。"""

    name: str = "Standard"
    scale: float = 1.0
    textHeight: float = 2.5
    arrowSize: float = 2.5
    extensionOffset: float = 0.625
    extensionBeyond: float = 0.625
    textGap: float = 0.625
    centerMarkSize: float = 2.5
    dimensionLineColor: Optional[str] = None
    extensionLineColor: Optional[str] = None
    textColor: Optional[str] = None
    suppressFirstExtension: bool = False
    suppressSecondExtension: bool = False
    suppressDimensionLine: bool = False
    textStyle: Optional[str] = None
    textPrefix: Optional[str] = None
    textSuffix: Optional[str] = None


class DimensionStyleOverride(BaseModel):
    """单个标注相对于 DIMSTYLE 的显式覆盖项。"""

    textHeight: Optional[float] = None
    arrowSize: Optional[float] = None
    extensionOffset: Optional[float] = None
    extensionBeyond: Optional[float] = None
    textGap: Optional[float] = None
    centerMarkSize: Optional[float] = None
    dimensionLineColor: Optional[str] = None
    extensionLineColor: Optional[str] = None
    textColor: Optional[str] = None
    suppressFirstExtension: Optional[bool] = None
    suppressSecondExtension: Optional[bool] = None
    suppressDimensionLine: Optional[bool] = None
    textStyle: Optional[str] = None
    textPrefix: Optional[str] = None
    textSuffix: Optional[str] = None


class DimensionSourceReference(BaseModel):
    """半径或直径标注所测量圆的引用。"""

    kind: Literal["circle"]
    entityId: str


class SurfaceRoughnessSource(BaseModel):
    """可编辑表面粗糙度标记的持久化来源绑定。"""

    entityId: str
    entityFingerprint: str
    featureId: Optional[str] = None


class GeometricToleranceSource(BaseModel):
    """可编辑形位公差框的持久化来源绑定。"""

    entityId: str
    entityFingerprint: str


class DatumFeatureSource(BaseModel):
    """可编辑基准要素符号的持久化来源绑定。"""

    entityId: str
    entityFingerprint: str


class GeometricToleranceRow(BaseModel):
    """复合形位公差框中的一行语义定义。"""

    characteristic: Literal[
        "position", "flatness", "straightness", "circularity", "perpendicularity",
        "cylindricity", "parallelism", "angularity", "profile", "profile-of-line",
        "profile-of-surface", "concentricity", "symmetry", "circular-runout", "total-runout",
    ]
    tolerance: float = Field(gt=0, le=1e9)
    toleranceZone: Literal["none", "diameter"]
    materialCondition: Literal["none", "MMC", "LMC", "RFS"]
    datumReferences: list[str] = Field(max_items=3)


def _geometric_tolerance_row_key(row: GeometricToleranceRow) -> tuple:
    """返回用于验证复合公差行的语义键。"""
    return (
        row.characteristic,
        row.tolerance,
        row.toleranceZone,
        row.materialCondition,
        tuple(item.strip() for item in row.datumReferences),
    )


class Entity(BaseModel):
    id: str
    type: Literal["line", "polyline", "circle", "text", "annotation", "dimension"]
    layer: str = "default"
    color: Optional[str] = None
    colorMode: Optional[Literal["byLayer", "byBlock", "explicit"]] = None
    lineWidth: Optional[float] = None
    lineWidthMode: Optional[Literal["byLayer", "byBlock", "explicit"]] = None
    dxfLineType: Optional[str] = None
    polylineWidth: Optional[float] = None
    lineType: Optional[Literal["solid", "dashed", "dashdot"]] = "solid"
    lineTypeMode: Optional[Literal["byLayer", "byBlock", "explicit"]] = None
    # 直线
    start: Optional[Point] = None
    end: Optional[Point] = None
    # 多段线
    points: Optional[list[Point]] = None
    closed: bool = False
    curveGeometry: Optional[CurveGeometry] = None
    # 圆
    center: Optional[Point] = None
    radius: Optional[float] = None
    # 文字
    content: Optional[str] = None
    position: Optional[Point] = None
    fontSize: Optional[float] = None
    rotation: Optional[float] = None
    textStyle: Optional[str] = None
    textWidthFactor: Optional[float] = None
    textBoxWidth: Optional[float] = None
    dxfTextType: Optional[Literal["TEXT", "MTEXT"]] = "TEXT"
    textAlign: Optional[Literal["left", "center", "right"]] = "left"
    textBaseline: Optional[Literal["alphabetic", "top", "middle", "bottom"]] = "alphabetic"
    # 引线标注
    leader: Optional[list[Point]] = None
    text: Optional[str] = None
    annotationKind: Optional[Literal["surface-roughness", "geometric-tolerance", "datum-feature"]] = None
    surfaceRoughnessMetric: Optional[str] = None
    surfaceRoughnessValue: Optional[float] = None
    surfaceRoughnessUnit: Optional[str] = None
    surfaceRoughnessSource: Optional[SurfaceRoughnessSource] = None
    characteristic: Optional[Literal[
        "position", "flatness", "straightness", "circularity", "perpendicularity",
        "cylindricity", "parallelism", "angularity", "profile", "profile-of-line",
        "profile-of-surface", "concentricity", "symmetry",
        "circular-runout", "total-runout",
    ]] = None
    tolerance: Optional[float] = None
    toleranceZone: Optional[Literal["none", "diameter"]] = None
    materialCondition: Optional[Literal["none", "MMC", "LMC", "RFS"]] = None
    datumReferences: Optional[list[str]] = None
    geometricToleranceRows: Optional[list[GeometricToleranceRow]] = None
    geometricToleranceSource: Optional[GeometricToleranceSource] = None
    datumLabel: Optional[str] = None
    datumFeatureModifier: Optional[Literal["none", "MMC", "LMC"]] = None
    datumFeatureSource: Optional[DatumFeatureSource] = None
    annotationSegments: Optional[list[list[Point]]] = None
    textPositionManual: bool = False
    # 原生尺寸标注
    dimensionType: Optional[Literal["linear", "aligned", "angular", "radius", "diameter", "arcLength", "ordinate"]] = None
    dimensionStart: Optional[Point] = None
    dimensionEnd: Optional[Point] = None
    dimensionCenter: Optional[Point] = None
    dimensionRadius: Optional[float] = None
    dimensionAngularMode: Optional[Literal["twoLine", "threePoint"]] = None
    dimensionAngularLine1Start: Optional[Point] = None
    dimensionAngularLine2Start: Optional[Point] = None
    dimensionOrdinateType: Optional[Literal["x", "y"]] = None
    dimensionOrigin: Optional[Point] = None
    dimensionOffset: Optional[Point] = None
    dimensionLinePosition: Optional[Point] = None
    dimensionAngle: Optional[float] = None
    dimensionStyle: Optional[str] = None
    dimensionStyleOverrides: Optional[DimensionStyleOverride] = None
    dimensionSource: Optional[DimensionSourceReference] = None
    dimensionTextOverride: Optional[str] = None
    dimensionTextManual: bool = False
    dimensionTextHeightManual: bool = False

    @field_validator(
        "start",
        "end",
        "center",
        "position",
        "dimensionStart",
        "dimensionEnd",
        "dimensionCenter",
        "dimensionAngularLine1Start",
        "dimensionAngularLine2Start",
        "dimensionLinePosition",
        "dimensionOrigin",
        "dimensionOffset",
    )
    @classmethod
    def validate_point(cls, value: Optional[Point]) -> Optional[Point]:
        if value is not None and len(value) != 2:
            raise ValueError("坐标点必须包含 x 和 y 两个分量")
        return value

    @field_validator("points", "leader")
    @classmethod
    def validate_points(cls, value: Optional[list[Point]]) -> Optional[list[Point]]:
        if value is not None:
            for point in value:
                if len(point) != 2:
                    raise ValueError("每个坐标点必须包含 x 和 y 两个分量")
        return value

    @field_validator("annotationSegments")
    @classmethod
    def validate_annotation_segments(
        cls,
        value: Optional[list[list[Point]]],
    ) -> Optional[list[list[Point]]]:
        """验证每条形位公差框线段的两个端点。"""
        if value is not None:
            for segment in value:
                if len(segment) != 2:
                    raise ValueError("每条标注线段必须包含两个端点")
                for point in segment:
                    if len(point) != 2:
                        raise ValueError("标注线段的每个端点必须包含 x 和 y 两个分量")
        return value

    @root_validator(skip_on_failure=True)
    def validate_geometric_tolerance_rows(cls, values):
        """使双行 DXF 实体与旧版顶层字段保持一致。"""
        rows = values.get("geometricToleranceRows")
        if rows is None:
            return values
        if len(rows) != 2:
            raise ValueError("复合形位公差必须恰好包含两行")
        if values.get("annotationKind") != "geometric-tolerance":
            raise ValueError("复合形位公差行只能用于形位公差标注")
        first = (
            values.get("characteristic"),
            values.get("tolerance"),
            values.get("toleranceZone"),
            values.get("materialCondition"),
            tuple(item.strip() for item in (values.get("datumReferences") or [])),
        )
        if first != _geometric_tolerance_row_key(rows[0]):
            raise ValueError("复合形位公差的首行必须与兼容的顶层字段一致")
        if _geometric_tolerance_row_key(rows[0]) == _geometric_tolerance_row_key(rows[1]):
            raise ValueError("复合形位公差的两行不能相同")
        return values


class Drawing(BaseModel):
    unit: Literal["mm", "inch"] = "mm"
    width: float = Field(gt=0)
    height: float = Field(gt=0)
    entities: list[Entity]
    layers: list[LayerDefinition] = Field(default_factory=list)
    dimensionStyles: list[DimensionStyleDefinition] = Field(default_factory=list)
    currentDimensionStyle: Optional[str] = None


class DxfReferenceTransform(BaseModel):
    """原始 DXF WCS 坐标到编辑器 world 坐标的变换。"""

    scale: float = Field(gt=0)
    offsetX: float
    offsetY: float


class MergeDxfRequest(BaseModel):
    """在原始 DXF 上应用编辑覆盖层的请求。"""

    originalDxf: str = Field(min_length=1)
    drawing: Drawing
    removedHandles: list[str] = Field(default_factory=list)
    transform: DxfReferenceTransform


def to_dxf_point(point: Point, height: float) -> tuple[float, float]:
    """SVG 向下 Y 轴 → DXF 向上 Y 轴：y' = height - y。"""
    x, y = point
    return x, height - y


def to_original_dxf_point(
    point: Point,
    transform: DxfReferenceTransform,
) -> tuple[float, float]:
    """编辑器 world 坐标 → 原始 DXF WCS 坐标。"""
    x, y = point
    return (
        (x - transform.offsetX) / transform.scale,
        -(y - transform.offsetY) / transform.scale,
    )


def hex_to_true_color(hex_color: str) -> Optional[int]:
    """#RRGGBB → DXF true_color 整数。"""
    if not hex_color:
        return None
    value = hex_color.strip().lstrip("#")
    if len(value) == 6:
        try:
            return int(value, 16)
        except ValueError:
            return None
    return None


def hex_to_aci(hex_color: Optional[str]) -> Optional[int]:
    """把常用十六进制颜色转换为 DIMSTYLE 可保存的 ACI 索引。"""
    if not hex_color:
        return None
    colors = {
        "#FF0000": 1,
        "#FFFF00": 2,
        "#00FF00": 3,
        "#00FFFF": 4,
        "#0000FF": 5,
        "#FF00FF": 6,
        "#FFFFFF": 7,
        "#808080": 8,
        "#C0C0C0": 9,
        "#000000": 250,
    }
    return colors.get(hex_color.strip().upper())


@lru_cache(maxsize=512)
def hex_to_nearest_aci(hex_color: str) -> Optional[int]:
    """为任意真彩色返回兼容性较好的 ACI 回退色。"""
    true_color = hex_to_true_color(hex_color)
    if true_color is None:
        return None
    exact = hex_to_aci(hex_color)
    if exact is not None:
        return exact
    red = (true_color >> 16) & 0xFF
    green = (true_color >> 8) & 0xFF
    blue = true_color & 0xFF
    candidates = range(1, 255)
    return min(candidates, key=lambda index: (
        (aci2rgb(index).r - red) ** 2
        + (aci2rgb(index).g - green) ** 2
        + (aci2rgb(index).b - blue) ** 2
    ))


def set_units(doc: ezdxf.EzDxfDocument, unit: str) -> None:
    doc.units = ezdxf.units.MM if unit == "mm" else ezdxf.units.IN


def ensure_layers(doc: ezdxf.EzDxfDocument, drawing: Drawing) -> None:
    """创建并同步图纸图层，保留显示、冻结、锁定和默认样式。"""
    definitions = {layer.name: layer for layer in drawing.layers}
    names = {entity.layer or "default" for entity in drawing.entities}
    names.update(definitions)
    for name in sorted(names):
        definition = definitions.get(name)
        layer = doc.layers.get(name) if name in doc.layers else doc.layers.add(name)
        if definition is None:
            continue
        true_color = hex_to_true_color(definition.color)
        if true_color is not None:
            layer.dxf.true_color = true_color
        fallback_color = hex_to_nearest_aci(definition.color) or 7
        layer.dxf.color = fallback_color if definition.visible else -fallback_color
        layer.dxf.flags = (1 if definition.frozen else 0) | (4 if definition.locked else 0)
        layer.dxf.linetype = definition.dxfLineType or ("DASHED" if definition.lineType == "dashed" else "DASHDOT" if definition.lineType == "dashdot" else "CONTINUOUS")
        if definition.lineWidth is not None and definition.lineWidth > 0:
            millimeters = definition.lineWidth * 25.4 if drawing.unit == "inch" else definition.lineWidth
            layer.dxf.lineweight = max(0, min(211, round(millimeters * 100)))
        apply_layer_editor_style(layer, definition)


def ensure_editor_style_appid(doc: ezdxf.EzDxfDocument) -> None:
    """注册用于无损保存编辑器样式元数据的应用 ID。"""
    if EDITOR_STYLE_APPID not in doc.appids:
        doc.appids.add(EDITOR_STYLE_APPID)


def apply_layer_editor_style(layer, definition: LayerDefinition) -> None:
    """保留超出标准 DXF 线宽范围的精确图层样式。"""
    ensure_editor_style_appid(layer.doc)
    tags = [(1000, f"COLOR={definition.color.upper()}")]
    if definition.lineWidth is not None and definition.lineWidth > 0:
        tags.append((1000, f"LINEWIDTH={definition.lineWidth:.12g}"))
    layer.set_xdata(EDITOR_STYLE_APPID, tags)


def apply_entity_editor_style(dxf_entity, source: Entity) -> None:
    """保留标准 DXF 属性，同时附加精确的显式实体样式。"""
    tags = []
    if source.colorMode == "explicit" and source.color:
        tags.append((1000, f"COLOR={source.color.upper()}"))
    if source.lineWidthMode == "explicit" and source.lineWidth is not None and source.lineWidth > 0:
        tags.append((1000, f"LINEWIDTH={source.lineWidth:.12g}"))
    if not tags:
        return
    ensure_editor_style_appid(dxf_entity.doc)
    dxf_entity.set_xdata(EDITOR_STYLE_APPID, tags)


def ensure_linetypes(doc: ezdxf.EzDxfDocument) -> None:
    if "DASHED" not in doc.linetypes:
        doc.linetypes.add("DASHED", pattern=[0.6, 0.4, -0.2], description="虚线")
    if "DASHDOT" not in doc.linetypes:
        doc.linetypes.add("DASHDOT", pattern=[1.0, 0.5, -0.2, 0.0, -0.2], description="点画线")
    if EDITOR_DASHED_LINETYPE not in doc.linetypes:
        doc.linetypes.add(EDITOR_DASHED_LINETYPE, pattern=[6.0, 4.0, -2.0], description="Draiq 虚线")
    if EDITOR_DASHDOT_LINETYPE not in doc.linetypes:
        doc.linetypes.add(
            EDITOR_DASHDOT_LINETYPE,
            pattern=[10.0, 6.0, -2.0, 0.0, -2.0],
            description="Draiq 点画线",
        )


def ensure_dimension_styles(doc: ezdxf.EzDxfDocument, drawing: Drawing) -> None:
    """创建新 DXF 所需的 DIMSTYLE，并写入编辑器样式字段。"""
    definitions = {style.name.strip() or "Standard": style for style in drawing.dimensionStyles}
    definitions.setdefault("Standard", DimensionStyleDefinition())
    current_style = (drawing.currentDimensionStyle or "").strip()
    if current_style:
        definitions.setdefault(current_style, DimensionStyleDefinition(name=current_style))
    for entity in drawing.entities:
        if entity.type == "dimension" and entity.dimensionStyle:
            name = entity.dimensionStyle.strip()
            if name and name not in definitions:
                definitions[name] = DimensionStyleDefinition(name=name)
    for name, definition in definitions.items():
        style = doc.dimstyles.get(name) if name in doc.dimstyles else doc.dimstyles.add(name)
        style.dxf.dimscale = max(definition.scale, 1e-6)
        style.dxf.dimasz = max(definition.arrowSize, 1e-6)
        style.dxf.dimexo = max(definition.extensionOffset, 0.0)
        style.dxf.dimexe = max(definition.extensionBeyond, 0.0)
        style.dxf.dimtxt = max(definition.textHeight, 1e-6)
        style.dxf.dimgap = max(definition.textGap, 0.0)
        style.dxf.dimcen = max(definition.centerMarkSize, 0.0)
        style.dxf.dimse1 = 1 if definition.suppressFirstExtension else 0
        style.dxf.dimse2 = 1 if definition.suppressSecondExtension else 0
        style.dxf.dimsd1 = 1 if definition.suppressDimensionLine else 0
        style.dxf.dimsd2 = 1 if definition.suppressDimensionLine else 0
        dimension_color = hex_to_aci(definition.dimensionLineColor)
        extension_color = hex_to_aci(definition.extensionLineColor)
        text_color = hex_to_aci(definition.textColor)
        if dimension_color is not None:
            style.dxf.dimclrd = dimension_color
        if extension_color is not None:
            style.dxf.dimclre = extension_color
        if text_color is not None:
            style.dxf.dimclrt = text_color
        if definition.textStyle and definition.textStyle in doc.styles:
            style.dxf.dimtxsty = doc.styles.get(definition.textStyle).dxf.handle
        if definition.textPrefix is not None or definition.textSuffix is not None:
            style.dxf.dimpost = f"{definition.textPrefix or ''}<>{definition.textSuffix or ''}"


def dimension_override(entity: Entity, size_scale: float) -> dict:
    """把实体级样式覆盖转换为 ezdxf DIMENSION override 字段。"""
    override: dict = {}
    custom = entity.dimensionStyleOverrides
    text_height = custom.textHeight if custom and custom.textHeight is not None else None
    if entity.dimensionTextHeightManual and entity.fontSize is not None:
        text_height = entity.fontSize
    if text_height is not None and text_height > 0:
        override["dimtxt"] = text_height * size_scale
    if custom:
        numeric_fields = {
            "arrowSize": "dimasz",
            "extensionOffset": "dimexo",
            "extensionBeyond": "dimexe",
            "textGap": "dimgap",
            "centerMarkSize": "dimcen",
        }
        for field, dxf_name in numeric_fields.items():
            value = getattr(custom, field)
            if value is not None and value >= 0:
                override[dxf_name] = value * size_scale
        if custom.suppressFirstExtension is not None:
            override["dimse1"] = 1 if custom.suppressFirstExtension else 0
        if custom.suppressSecondExtension is not None:
            override["dimse2"] = 1 if custom.suppressSecondExtension else 0
        if custom.suppressDimensionLine is not None:
            value = 1 if custom.suppressDimensionLine else 0
            override["dimsd1"] = value
            override["dimsd2"] = value
        color_fields = {
            "dimensionLineColor": "dimclrd",
            "extensionLineColor": "dimclre",
            "textColor": "dimclrt",
        }
        for field, dxf_name in color_fields.items():
            color = hex_to_aci(getattr(custom, field))
            if color is not None:
                override[dxf_name] = color
        if custom.textPrefix is not None or custom.textSuffix is not None:
            override["dimpost"] = f"{custom.textPrefix or ''}<>{custom.textSuffix or ''}"
    linetype = cad_linetype_name(entity)
    if linetype:
        override["dimltype"] = linetype
        override["dimltex1"] = linetype
        override["dimltex2"] = linetype
    return override


def cad_linetype_name(entity: Entity) -> Optional[str]:
    """解析实体和原生尺寸标注使用的 DXF 线型名称。"""
    if entity.lineTypeMode == "byBlock":
        return "BYBLOCK"
    if entity.lineTypeMode == "byLayer":
        return None
    dxf_line_type = (entity.dxfLineType or "").strip()
    normalized_dxf_line_type = dxf_line_type.upper()
    common_line_types = {"", "DASHED", "DASHDOT", EDITOR_DASHED_LINETYPE, EDITOR_DASHDOT_LINETYPE}
    if entity.lineType == "dashed" and normalized_dxf_line_type in common_line_types:
        return EDITOR_DASHED_LINETYPE
    if entity.lineType == "dashdot" and normalized_dxf_line_type in common_line_types:
        return EDITOR_DASHDOT_LINETYPE
    if dxf_line_type and normalized_dxf_line_type not in {"BYLAYER", "BYBLOCK"}:
        return dxf_line_type
    return None


def dxfattribs(entity: Entity, drawing_unit: str) -> dict:
    """构造实体的 DXF 属性，按实体继承模式输出颜色、线型和线宽。"""
    attrs: dict = {"layer": entity.layer or "default"}
    true_color = hex_to_true_color(entity.color or "")
    if entity.colorMode != "byLayer" and true_color is not None:
        attrs["true_color"] = true_color
        attrs["color"] = hex_to_nearest_aci(entity.color or "") or 7
    if entity.colorMode == "byBlock":
        attrs["color"] = 0
    linetype = cad_linetype_name(entity)
    if linetype:
        attrs["linetype"] = linetype
    if entity.lineWidthMode == "byBlock":
        attrs["lineweight"] = -2
    elif entity.lineWidthMode != "byLayer" and entity.lineWidth is not None and entity.lineWidth > 0:
        millimeters = entity.lineWidth * 25.4 if drawing_unit == "inch" else entity.lineWidth
        attrs["lineweight"] = max(0, min(211, round(millimeters * 100)))
    if entity.textStyle:
        attrs["style"] = entity.textStyle
    return attrs


def add_entity(
    msp,
    entity: Entity,
    height: float,
    drawing_unit: str,
    current_dimension_style: Optional[str] = None,
) -> None:
    """把普通编辑器图元写入新建 DXF。"""
    add_entity_with_point_mapper(
        msp,
        entity,
        lambda point: to_dxf_point(point, height),
        1.0,
        drawing_unit,
        current_dimension_style,
    )


def cad_geometric_width(entity: Entity, size_scale: float, drawing_unit: str) -> Optional[float]:
    """请求线宽超出 DXF 线宽范围时，使用原生多段线几何宽度。"""
    if entity.lineWidthMode != "explicit" or entity.lineWidth is None or entity.lineWidth <= 0:
        return None
    millimeters = entity.lineWidth * 25.4 if drawing_unit == "inch" else entity.lineWidth
    if millimeters <= 2.11:
        return None
    return entity.lineWidth * size_scale


def _add_entity_with_point_mapper(
    msp,
    entity: Entity,
    map_point,
    size_scale: float,
    drawing_unit: str,
    current_dimension_style: Optional[str] = None,
) -> None:
    """使用指定坐标逆变换写入图元，供新建和合并导出共用。"""
    attrs = dxfattribs(entity, drawing_unit)

    if entity.type == "line":
        if not entity.start or not entity.end:
            raise HTTPException(status_code=400, detail=f"{entity.id}: 直线必须包含起点和终点")
        points = [map_point(entity.start), map_point(entity.end)]
        geometric_width = cad_geometric_width(entity, size_scale, drawing_unit)
        if geometric_width is not None:
            wide_line = msp.add_lwpolyline(points, dxfattribs=attrs)
            wide_line.dxf.const_width = geometric_width
        else:
            msp.add_line(points[0], points[1], dxfattribs=attrs)
        return
    if entity.type == "polyline":
        if entity.curveGeometry:
            curve = entity.curveGeometry
            mapped_center = map_point(curve.center)

            def mapped_point_at(parameter: float):
                return map_point([
                    curve.center[0] + curve.axisX[0] * cos(parameter) + curve.axisY[0] * sin(parameter),
                    curve.center[1] + curve.axisX[1] * cos(parameter) + curve.axisY[1] * sin(parameter),
                ])

            axis_x_end = map_point([
                curve.center[0] + curve.axisX[0],
                curve.center[1] + curve.axisX[1],
            ])
            axis_y_end = map_point([
                curve.center[0] + curve.axisY[0],
                curve.center[1] + curve.axisY[1],
            ])
            major_axis = (
                axis_x_end[0] - mapped_center[0],
                axis_x_end[1] - mapped_center[1],
            )
            minor_axis = (
                axis_y_end[0] - mapped_center[0],
                axis_y_end[1] - mapped_center[1],
            )
            major_length = max(hypot(*major_axis), 1e-9)
            minor_length = max(hypot(*minor_axis), 1e-9)
            full_curve = abs(curve.sweepParameter) >= 2 * pi - 1e-7
            circle_like = abs(major_length - minor_length) <= max(major_length, minor_length) * 1e-7
            orthogonal = abs(major_axis[0] * minor_axis[0] + major_axis[1] * minor_axis[1]) <= major_length * minor_length * 1e-7
            if curve.type == "arc" and circle_like and orthogonal and not full_curve:
                start_point = mapped_point_at(curve.startParameter)
                end_point = mapped_point_at(curve.startParameter + curve.sweepParameter)
                start_angle = degrees(atan2(start_point[1] - mapped_center[1], start_point[0] - mapped_center[0]))
                end_angle = degrees(atan2(end_point[1] - mapped_center[1], end_point[0] - mapped_center[0]))
                if curve.sweepParameter >= 0:
                    while end_angle <= start_angle:
                        end_angle += 360
                else:
                    while end_angle >= start_angle:
                        end_angle -= 360
                msp.add_arc(
                    mapped_center,
                    major_length,
                    start_angle,
                    end_angle,
                    # 编辑器 Y 轴向下，因此写入 Y 轴向上的 DXF 圆弧时，
                    # 需要镜像参数方向。
                    is_counter_clockwise=curve.sweepParameter < 0,
                    dxfattribs=attrs,
                )
                return
            if circle_like and orthogonal and full_curve:
                msp.add_circle(mapped_center, major_length, dxfattribs=attrs)
                return
            start_param = curve.startParameter
            end_param = curve.startParameter + curve.sweepParameter
            if minor_length > major_length:
                # ELLIPSE 要求 major_axis 为长轴；交换参数轴后使用 t' = pi/2 - t。
                major_axis, minor_axis = minor_axis, major_axis
                major_length, minor_length = minor_length, major_length
                start_param = pi / 2 - start_param
                end_param = pi / 2 - end_param
            # 编辑器 Y 轴向下，而 DXF 默认 OCS 的短轴方向由法向量确定。
            # 轴向叉积为负时，导出参数需要取反，避免部分椭圆弧发生镜像。
            axis_orientation = major_axis[0] * minor_axis[1] - major_axis[1] * minor_axis[0]
            if axis_orientation < 0:
                start_param = -start_param
                end_param = -end_param
            msp.add_ellipse(
                mapped_center,
                major_axis=major_axis,
                ratio=min(1.0, minor_length / major_length),
                start_param=start_param,
                end_param=end_param,
                dxfattribs=attrs,
            )
            return
        if not entity.points or len(entity.points) < 2:
            raise HTTPException(status_code=400, detail=f"{entity.id}: 多段线至少需要两个顶点")
        points = [map_point(point) for point in entity.points]
        polyline = msp.add_lwpolyline(points, close=entity.closed, dxfattribs=attrs)
        if entity.polylineWidth is not None and entity.polylineWidth > 0:
            polyline.dxf.const_width = entity.polylineWidth * size_scale
        else:
            geometric_width = cad_geometric_width(entity, size_scale, drawing_unit)
            if geometric_width is not None:
                polyline.dxf.const_width = geometric_width
        return

    if entity.type == "circle":
        if not entity.center or entity.radius is None or entity.radius <= 0:
            raise HTTPException(status_code=400, detail=f"{entity.id}: 圆必须包含圆心及大于零的半径")
        msp.add_circle(
            map_point(entity.center),
            entity.radius * size_scale,
            dxfattribs=attrs,
        )
        return

    if entity.type == "text":
        content = (entity.content or "").strip()
        if not content or not entity.position:
            raise HTTPException(status_code=400, detail=f"{entity.id}: 文字必须包含内容和位置")
        height_val = (entity.fontSize or 2.5) * size_scale
        angle = -(entity.rotation or 0) % 360
        if entity.dxfTextType == "MTEXT":
            text = msp.add_mtext(content, dxfattribs={**attrs, "char_height": height_val, "rotation": angle})
            text.set_location(
                map_point(entity.position),
                rotation=angle,
                attachment_point=mtext_attachment(entity.textAlign, entity.textBaseline),
            )
            if entity.textBoxWidth is not None and entity.textBoxWidth > 0:
                text.dxf.width = entity.textBoxWidth * size_scale
        else:
            text = msp.add_text(content, dxfattribs={**attrs, "height": height_val, "rotation": angle})
            if entity.textWidthFactor is not None and entity.textWidthFactor > 0:
                text.dxf.width = entity.textWidthFactor
            text.set_placement(map_point(entity.position), align=text_alignment(entity.textAlign, entity.textBaseline))
        return

    if entity.type == "dimension":
        current_style = (current_dimension_style or "").strip() or "Standard"
        requested_style = (entity.dimensionStyle or "").strip() or current_style
        dimension_style = requested_style if requested_style in msp.doc.dimstyles else "Standard"
        text = entity.dimensionTextOverride or (entity.text if entity.dimensionTextManual and entity.text else "<>")
        override = dimension_override(entity, size_scale)
        location = map_point(entity.position) if entity.position and entity.textPositionManual else None
        if entity.dimensionType in {"linear", "aligned"}:
            if not entity.dimensionStart or not entity.dimensionEnd or not entity.dimensionLinePosition:
                raise HTTPException(status_code=400, detail=f"{entity.id}: 线性标注必须包含两个测量点和尺寸线位置")
            start = map_point(entity.dimensionStart)
            end = map_point(entity.dimensionEnd)
            line_position = map_point(entity.dimensionLinePosition)
        if entity.dimensionType == "linear":
            # 编辑器 Y 轴向下，DXF Y 轴向上且角度以逆时针为正。
            angle = -(entity.dimensionAngle or 0)
            dimension = msp.add_linear_dim(
                line_position,
                start,
                end,
                location=line_position,
                text=text,
                angle=angle,
                dimstyle=dimension_style,
                override=override,
                dxfattribs=attrs,
            )
        elif entity.dimensionType == "aligned":
            dx = end[0] - start[0]
            dy = end[1] - start[1]
            length = max(hypot(dx, dy), 1e-9)
            # 有符号距离保留尺寸线位于被测几何哪一侧的信息。
            distance = ((line_position[0] - start[0]) * (-dy / length)
                        + (line_position[1] - start[1]) * (dx / length))
            if abs(distance) < 1e-6:
                distance = 1.0 * size_scale
            dimension = msp.add_aligned_dim(
                start,
                end,
                distance,
                text=text,
                dimstyle=dimension_style,
                override=override,
                dxfattribs=attrs,
            )
            # ezdxf 的对齐标注辅助函数复用旋转线性标注构造器，
            # 且基础类型仍为 0。保留生成的几何块，
            # 同时保持 DXF 对齐标注语义。
            dimension.dimension.dxf.dimtype = const.DIM_ALIGNED | const.DIM_BLOCK_EXCLUSIVE
        elif entity.dimensionType == "angular":
            if not entity.dimensionStart or not entity.dimensionEnd or not entity.dimensionCenter or not entity.dimensionLinePosition:
                raise HTTPException(status_code=400, detail=f"{entity.id}: 角度标注必须包含圆心、两个测量点和尺寸线位置")
            start = map_point(entity.dimensionStart)
            end = map_point(entity.dimensionEnd)
            center = map_point(entity.dimensionCenter)
            base = map_point(entity.dimensionLinePosition)
            if entity.dimensionAngularMode == "twoLine" and entity.dimensionAngularLine1Start and entity.dimensionAngularLine2Start:
                line1 = (map_point(entity.dimensionAngularLine1Start), start)
                line2 = (map_point(entity.dimensionAngularLine2Start), end)
                dimension = msp.add_angular_dim_2l(
                    base,
                    line1,
                    line2,
                    location=location,
                    text=text,
                    text_rotation=-(entity.rotation or 0),
                    dimstyle=dimension_style,
                    override=override,
                    dxfattribs=attrs,
                )
            else:
                dimension = msp.add_angular_dim_3p(
                    base,
                    center,
                    start,
                    end,
                    location=location,
                    text=text,
                    text_rotation=-(entity.rotation or 0),
                    dimstyle=dimension_style,
                    override=override,
                    dxfattribs=attrs,
                )
        elif entity.dimensionType in {"radius", "diameter"}:
            if not entity.dimensionCenter or not entity.dimensionStart:
                raise HTTPException(status_code=400, detail=f"{entity.id}: 半径或直径标注必须包含圆心和测量点")
            center = map_point(entity.dimensionCenter)
            measurement = map_point(entity.dimensionStart)
            radius = entity.dimensionRadius
            if radius is None or radius <= 0:
                radius = hypot(measurement[0] - center[0], measurement[1] - center[1])
            radius *= size_scale
            factory = msp.add_radius_dim if entity.dimensionType == "radius" else msp.add_diameter_dim
            dimension = factory(
                center,
                mpoint=measurement,
                text=text,
                dimstyle=dimension_style,
                override=override,
                dxfattribs=attrs,
            )
            if location is not None:
                dimension.user_location_override(location)
        elif entity.dimensionType == "arcLength":
            if not entity.dimensionCenter or not entity.dimensionStart or not entity.dimensionEnd or not entity.dimensionLinePosition:
                raise HTTPException(status_code=400, detail=f"{entity.id}: 弧长标注必须包含圆心、端点和尺寸线位置")
            dimension = msp.add_arc_dim_3p(
                map_point(entity.dimensionLinePosition),
                map_point(entity.dimensionCenter),
                map_point(entity.dimensionStart),
                map_point(entity.dimensionEnd),
                location=location,
                text=text,
                text_rotation=-(entity.rotation or 0),
                dimstyle=dimension_style,
                override=override,
                dxfattribs=attrs,
            )
        elif entity.dimensionType == "ordinate":
            if not entity.dimensionStart or not entity.dimensionOrigin:
                raise HTTPException(status_code=400, detail=f"{entity.id}: 坐标标注必须包含原点和特征点")
            feature = map_point(entity.dimensionStart)
            origin = map_point(entity.dimensionOrigin)
            endpoint = map_point(entity.dimensionOffset or entity.dimensionEnd or entity.dimensionLinePosition or entity.dimensionStart)
            offset = (endpoint[0] - feature[0], endpoint[1] - feature[1])
            dimension = msp.add_ordinate_dim(
                feature,
                offset,
                1 if entity.dimensionOrdinateType == "x" else 0,
                origin=origin,
                rotation=-(entity.dimensionAngle or 0),
                text=text,
                dimstyle=dimension_style,
                override=override,
                dxfattribs=attrs,
            )
        else:
            raise HTTPException(status_code=400, detail=f"{entity.id}: 不支持的标注类型 {entity.dimensionType}")
        dimension.render()
        return

    if entity.type == "annotation":
        if not entity.leader or len(entity.leader) < 2:
            raise HTTPException(status_code=400, detail=f"{entity.id}: 标注必须包含至少两个点的引线")
        if entity.annotationKind == "surface-roughness":
            leader_pts = [map_point(p) for p in entity.leader]
            msp.add_lwpolyline(leader_pts, close=False, dxfattribs=attrs)
        elif entity.annotationKind == "geometric-tolerance":
            leader_pts = [map_point(p) for p in entity.leader]
            msp.add_lwpolyline(leader_pts, close=False, dxfattribs=attrs)
            for segment in entity.annotationSegments or []:
                if len(segment) != 2:
                    continue
                msp.add_line(map_point(segment[0]), map_point(segment[1]), dxfattribs=attrs)
        elif entity.annotationKind == "datum-feature":
            leader_pts = [map_point(p) for p in entity.leader]
            msp.add_lwpolyline(leader_pts, close=False, dxfattribs=attrs)
            for segment in entity.annotationSegments or []:
                if len(segment) != 2:
                    continue
                msp.add_line(map_point(segment[0]), map_point(segment[1]), dxfattribs=attrs)
        elif len(entity.leader) >= 4:
            start, end, dim_start, dim_end = entity.leader[:4]
            def extension_points(measure, dimension):
                dx = dimension[0] - measure[0]
                dy = dimension[1] - measure[1]
                length = max(hypot(dx, dy), 1e-6)
                ux, uy = dx / length, dy / length
                return (
                    [measure[0] + ux * 3.0, measure[1] + uy * 3.0],
                    [dimension[0] + ux * 4.0, dimension[1] + uy * 4.0],
                )

            left_start, left_end = extension_points(start, dim_start)
            right_start, right_end = extension_points(end, dim_end)
            msp.add_line(map_point(left_start), map_point(left_end), dxfattribs=attrs)
            msp.add_line(map_point(right_start), map_point(right_end), dxfattribs=attrs)
            msp.add_line(map_point(dim_start), map_point(dim_end), dxfattribs=attrs)
            dx = dim_end[0] - dim_start[0]
            dy = dim_end[1] - dim_start[1]
            length = max(hypot(dx, dy), 1e-6)
            ux, uy = dx / length, dy / length
            nx, ny = -uy, ux
            line_width = max(entity.lineWidth or 0.25, 0.1)
            font_size = max(entity.fontSize or 2.5, 1.0)
            preferred_arrow_length = min(5.0, max(2.2, font_size * 0.32 + line_width * 0.6))
            # 短尺寸线按总长度收缩箭头，避免两端箭头互相重叠。
            arrow_length = max(0.15, min(preferred_arrow_length, length * 0.24))
            half_width = min(1.6, arrow_length * 0.3)
            start_triangle = [
                dim_start,
                [dim_start[0] + ux * arrow_length + nx * half_width, dim_start[1] + uy * arrow_length + ny * half_width],
                [dim_start[0] + ux * arrow_length - nx * half_width, dim_start[1] + uy * arrow_length - ny * half_width],
            ]
            end_triangle = [
                dim_end,
                [dim_end[0] - ux * arrow_length + nx * half_width, dim_end[1] - uy * arrow_length + ny * half_width],
                [dim_end[0] - ux * arrow_length - nx * half_width, dim_end[1] - uy * arrow_length - ny * half_width],
            ]
            for triangle in (start_triangle, end_triangle):
                points = [map_point(point) for point in triangle]
                msp.add_solid([points[0], points[1], points[2], points[2]], dxfattribs=attrs)
        else:
            leader_pts = [map_point(p) for p in entity.leader]
            msp.add_lwpolyline(leader_pts, close=False, dxfattribs=attrs)
        text_content = (entity.text or "").strip()
        if text_content and entity.position:
            height_val = (entity.fontSize or 2.5) * size_scale
            angle = -(entity.rotation or 0) % 360
            if entity.annotationKind == "geometric-tolerance" and entity.geometricToleranceRows and len(entity.geometricToleranceRows) == 2:
                text = msp.add_mtext(
                    text_content,
                    dxfattribs={**attrs, "char_height": height_val, "rotation": angle},
                )
                text.set_location(
                    map_point(entity.position),
                    rotation=angle,
                    attachment_point=mtext_attachment(entity.textAlign, entity.textBaseline),
                )
                if entity.textBoxWidth is not None and entity.textBoxWidth > 0:
                    text.dxf.width = entity.textBoxWidth * size_scale
            else:
                text = msp.add_text(text_content, dxfattribs={**attrs, "height": height_val, "rotation": angle})
                text.set_placement(map_point(entity.position), align=text_alignment(entity.textAlign, entity.textBaseline))
        return


def add_entity_with_point_mapper(
    msp,
    entity: Entity,
    map_point,
    size_scale: float,
    drawing_unit: str,
    current_dimension_style: Optional[str] = None,
) -> None:
    """写入实体，并在每个生成的 DXF 实体中保留精确编辑器样式。"""
    start_index = len(msp)
    _add_entity_with_point_mapper(msp, entity, map_point, size_scale, drawing_unit, current_dimension_style)
    for index in range(start_index, len(msp)):
        apply_entity_editor_style(msp[index], entity)


def text_alignment(align: Optional[str], baseline: Optional[str]) -> TextEntityAlignment:
    horizontal = align if align in {"left", "center", "right"} else "left"
    if baseline == "top":
        name = {"left": "TOP_LEFT", "center": "TOP_CENTER", "right": "TOP_RIGHT"}[horizontal]
    elif baseline == "middle":
        name = {"left": "MIDDLE_LEFT", "center": "MIDDLE_CENTER", "right": "MIDDLE_RIGHT"}[horizontal]
    elif baseline == "bottom":
        name = {"left": "BOTTOM_LEFT", "center": "BOTTOM_CENTER", "right": "BOTTOM_RIGHT"}[horizontal]
    else:
        name = {"left": "LEFT", "center": "CENTER", "right": "RIGHT"}[horizontal]
    return getattr(TextEntityAlignment, name)


def mtext_attachment(align: Optional[str], baseline: Optional[str]) -> int:
    column = {"left": 1, "center": 2, "right": 3}.get(align or "left", 1)
    row = {"top": 1, "middle": 2, "bottom": 3}.get(baseline or "top", 1)
    return (row - 1) * 3 + column


def inject_export_comments(content: str) -> str:
    """在 DXF HEADER 段写入不会影响 CAD 解析的 999 注释。"""
    exported_at = datetime.now(EXPORT_TIMEZONE).isoformat(timespec="seconds")
    comments = f"999\nauthor=TOOLS ERA\n999\nexport_date={exported_at}\n"
    for marker in ("  0\nSECTION\n  2\nHEADER\n", "0\nSECTION\n2\nHEADER\n"):
        if marker in content:
            return content.replace(marker, marker + comments, 1)
    return comments + content


def dxf_response(doc: ezdxf.EzDxfDocument) -> Response:
    """将 ezdxf 文档序列化为浏览器下载响应。"""
    modelspace = doc.modelspace()
    bounds = bbox.extents(modelspace, fast=True)
    if bounds.has_data:
        modelspace.dxf.extmin = bounds.extmin
        modelspace.dxf.extmax = bounds.extmax
        doc.update_extents()
    stream = StringIO()
    doc.write(stream)
    content = inject_export_comments(stream.getvalue())
    return Response(
        # R2004 及更早版本使用声明的代码页，R2007+ 使用 UTF-8；无法编码的
        # Unicode 字符由 ezdxf 转换为 DXF 的 \U+ 转义，保证响应字节与头部一致。
        content=doc.encode(content),
        media_type="application/dxf",
        headers={"Content-Disposition": 'attachment; filename="drawing.dxf"'},
    )


@app.post("/api/export/dxf", summary="导出 DXF 图纸")
def export_dxf(drawing: Drawing) -> Response:
    """将图纸数据转换为可下载的 DXF 文件。"""
    doc = ezdxf.new("R2010")
    set_units(doc, drawing.unit)
    ensure_layers(doc, drawing)
    ensure_linetypes(doc)
    ensure_dimension_styles(doc, drawing)

    msp = doc.modelspace()
    for entity in drawing.entities:
        add_entity(msp, entity, drawing.height, drawing.unit, drawing.currentDimensionStyle)

    return dxf_response(doc)


@app.post("/api/export/dxf/merge", summary="合并导出 DXF 图纸")
def merge_dxf(request: MergeDxfRequest) -> Response:
    """保留原 DXF 全量结构，仅替换/删除已编辑实体并追加新图元。"""
    try:
        # 将文本传入 ezdxf 的 StringIO 读取器前统一换行符。
        normalized_dxf = request.originalDxf.replace("\r\n", "\n").replace("\r", "\n")
        doc = ezdxf.read(StringIO(normalized_dxf))
    except Exception as exc:
        raise HTTPException(status_code=400, detail="无法读取原始 DXF，请确认文件完整且为有效的 ASCII DXF 格式") from exc

    removed = {handle.strip().upper() for handle in request.removedHandles if handle.strip()}
    for handle in removed:
        entity = doc.entitydb.get(handle)
        if entity is None:
            continue
        try:
            layout = entity.get_layout()
            if layout is not None:
                layout.delete_entity(entity)
            else:
                doc.entitydb.delete_entity(entity)
        except Exception:
            # 某些实体没有布局归属，直接从实体数据库清理。
            doc.entitydb.delete_entity(entity)

    ensure_layers(doc, request.drawing)
    ensure_linetypes(doc)
    ensure_dimension_styles(doc, request.drawing)
    modelspace = doc.modelspace()
    inverse_scale = 1.0 / request.transform.scale
    map_point = lambda point: to_original_dxf_point(point, request.transform)
    for entity in request.drawing.entities:
        add_entity_with_point_mapper(
            modelspace,
            entity,
            map_point,
            inverse_scale,
            request.drawing.unit,
            request.drawing.currentDimensionStyle,
        )

    return dxf_response(doc)


@app.get("/api/health", summary="检查绘图服务状态")
def health() -> dict:
    """健康检查接口。"""
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8011)
