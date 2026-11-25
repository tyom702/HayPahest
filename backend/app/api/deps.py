from typing import List, Optional
from fastapi import Depends, HTTPException, status, Header
from fastapi.security import OAuth2PasswordBearer
from jose import jwt, JWTError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.config import settings
from app.database import get_db
from app.models.user import User
from app.models.business import Business, BusinessMembership, RoleEnum
from app.schemas.auth import TokenPayload

oauth2_scheme = OAuth2PasswordBearer(tokenUrl=f"{settings.API_V1_STR}/auth/login")


async def get_current_user(
    db: AsyncSession = Depends(get_db),
    token: str = Depends(oauth2_scheme),
) -> User:
    """Extract and validate JWT token, returning the authenticated User."""
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Նույնականացումը չհաջողվեց: Խնդրում ենք կրկին մուտք գործել:",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(
            token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM]
        )
        user_id: str = payload.get("sub")
        if user_id is None:
            raise credentials_exception
    except JWTError:
        raise credentials_exception

    stmt = select(User).where(User.id == user_id, User.is_active == True)
    result = await db.execute(stmt)
    user = result.scalar_one_or_none()
    if user is None:
        raise credentials_exception
    return user


async def get_current_membership(
    db: AsyncSession = Depends(get_db),
    token: str = Depends(oauth2_scheme),
    current_user: User = Depends(get_current_user),
    x_business_id: Optional[str] = Header(None, alias="X-Business-ID"),
) -> BusinessMembership:
    """
    Ensure the user belongs to an active business workspace.
    Guarantees Multi-Tenant boundary: all further operations are scoped to this business_id.
    """
    try:
        payload = jwt.decode(
            token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM]
        )
        business_id: Optional[str] = x_business_id or payload.get("business_id")
    except JWTError:
        business_id = None

    query = select(BusinessMembership).where(
        BusinessMembership.user_id == current_user.id,
        BusinessMembership.is_active == True,
    )
    if business_id:
        query = query.where(BusinessMembership.business_id == business_id)

    result = await db.execute(query)
    membership = result.scalars().first()

    if not membership:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Դուք չունեք մուտքի իրավունք այս բիզնեսի աշխատանքային տարածքին:",
        )
    return membership


class RoleChecker:
    """
    Enforces server-side Role-Based Access Control (RBAC).
    Usage:
        Depends(RoleChecker([RoleEnum.OWNER, RoleEnum.MANAGER]))
    """
    def __init__(self, allowed_roles: List[RoleEnum]):
        self.allowed_roles = allowed_roles

    def __call__(
        self,
        membership: BusinessMembership = Depends(get_current_membership),
    ) -> BusinessMembership:
        if membership.role not in self.allowed_roles:
            roles_am = ", ".join([r.value for r in self.allowed_roles])
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Գործողությունը թույլատրված է միայն հետևյալ դերերին՝ {roles_am}: Ձեր դերն է՝ {membership.role.value}:",
            )
        return membership
